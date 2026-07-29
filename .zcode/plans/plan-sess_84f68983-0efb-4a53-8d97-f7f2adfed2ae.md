## Контекст і мета

**Проблема:** коли агент процес-рестартить, в БД контролера залишаються «leaked» `job_attempts` в активних станах (`running`/`collecting_artifacts`/`cleaning`), які насправді більше не виконуються. Вони роздувають `activeJobsCount` і можуть вичерпати `max_jobs`-слоти агента, блокуючи нові паралельні роботи. Зараз такі спроби гниють ~360с (grace 60s + orphan 300s) перед `markLost`, а агент ще й повторно репортує їх як «running» через stale `metadata.json`.

**Мета:** при рестарті агента миттєво очищати leaked спроби → `outcome=lost`, щоб оператору достатньо перезапустити агента для відновлення (без лазіння в БД).

**Погоджено з користувачем:**
- **Тригер очищення:** `boot_id` у capabilities (миттєве, точне розрізнення process-restart vs мережевого reconnect).
- **Доля leaked:** `fail (lost)` — `outcome='lost'`, `failure_category='agent_disconnected'` (узгоджено з існуючою `markLost`-семантикою).

---

## Ключова архітектурна інсайт (чому boot_id безпечний)

Агент будує `capabilities` **один раз при старті процесу** (`apps/agent/src/run.ts:35`) і **переиспользує той самий об'єкт** при мережевих reconnect (`client.ts:238-241`: `this.send(socket, 'capabilities', {...this.options.capabilities})`). Отже `boot_id`, згенерований раз при старті:
- Стабільний протягом життя процесу (мережевий reconnect → той самий boot_id → спроби збережено ✓).
- Змінюється лише при process restart → тригер очищення ✓.

---

## План реалізації

### 1. Wire контракт — `packages/protocol/src/schemas.ts`
Додати опціональне поле `boot_id` у `AgentCapabilityReportSchema` (рядок ~270):
```ts
boot_id: z.string().min(1).optional(),
```
з JSDoc-коментарем: «Унікальний маркер процесу агента, генерується при старті. Контролер порівнює зі збереженим, щоб виявити process restart і очистити leaked спроби. Optional — відсутній = не перевіряти (back-compat для старих агентів).»
**Без Rust-дзеркала:** `capabilities` не має Rust-структури (тільки wire-JSON, перевірено раніше) → wire-дріфт не виникає.

### 2. Генерація boot_id на боці агента — `apps/agent/src/run.ts`
- Імпортувати `generateId` з `@rbo/shared`.
- Згенерувати `const bootId = generateId('boot')` один раз при старті процесу (після `probeCapabilities`, рядок ~44), ДО створення `AgentConnection`.
- Передати `bootId` у `capabilities.boot_id = bootId` (мутація об'єкта перед `new AgentConnection({capabilities})`, рядок 72).
- `generateId` дає гарантовано унікальний маркер для кожного запуску процесу, незалежно від OS (на відміну від `processIdentityFromPid`, що може повернути null на деяких платформах).

### 3. Контролер: виявлення restart + очищення — `apps/controller/src/recovery/coordinator.ts`
Додати новий публічний метод `onAgentConnect(agentId, bootId)`:
```ts
/**
 * Agent (re)connected with a boot_id. When the boot_id differs from the last known one, the agent
 * process restarted, so any in-flight attempts pinned to it are leaked (the agent no longer runs
 * them). Fail them immediately as lost rather than waiting for grace/orphan timers. Same boot_id
 * = network reconnect with a live executor → attempts stay untouched.
 */
onAgentConnect(agentId: string, bootId: string | undefined): void
```
Логіка:
1. Прочитати попередній `boot_id` з БД (з `capabilities_json` або окремого сховища — див. крок 4).
2. Якщо `bootId` відсутній (старий агент) або співпадає з попереднім → нічого не робити (повернутись).
3. Якщо відрізняється (restart) → SELECT активних спроб цього агента (`SELECT id, job_id, state FROM job_attempts WHERE agent_id = ? AND state NOT IN ('completed')`) і для кожної викликати існуючий приватний `markLost(attempt)` (рядок 373) — він уже робить attempt→completed/lost + job→completed/lost з `agent_disconnected`. Додати лог: «agent restart detected, sweeping N leaked attempts».
4. Зберегти новий `boot_id` як «останній відомий».

**Перевикористання:** `markLost` + `clearAllTimersFor` + той самий SQL-запит що й `onAgentDisconnect` (рядки 98-108) — жодної дубльованої логіки.

### 4. Зберігання «останнього відомого boot_id» — `apps/controller/src/agents/registry.ts`
Оскільки `updateAgentCapabilities` перезаписує `capabilities_json`, потрібне окреме місце для попереднього boot_id. Два варіанти:
- **(А) Окрема колонка БД** `agents.last_boot_id` + міграція v4. Найчистіше, але вимагає нової міграції.
- **(Б) Зберігати в `AgentPlaneDispatchContext` / connectedAgents map** — in-memory only, скидається при рестарті контролера (але тоді `onControllerStartup` + reconcile-deadline покриває цей випадок).

**Рекомендація — варіант (А):** додати `last_boot_id TEXT` через міграцію v4 у `apps/controller/src/storage/migrations.ts`. Функція `updateAgentCapabilities` (registry.ts:15) розширюється, щоб також оновлювати `last_boot_id`. Початкове значення NULL. Це дає стійке порівняння навіть після рестарту контролера.

### 5. Підключення тригера — `apps/controller/src/websocket/server.ts`
У handler `capabilities` (рядки 336-346), ПЕРЕД `updateAgentCapabilities`:
```ts
case 'capabilities': {
  if (!authenticated) return;
  const parsed = AgentCapabilityReportSchema.safeParse(message.payload);
  if (parsed.success) {
    // Detect agent process restart via boot_id and sweep leaked attempts before refreshing caps.
    recovery.onAgentConnect(authenticated.agentId, parsed.data.boot_id);
    updateAgentCapabilities(db, authenticated.agentId, parsed.data);
    maybeDispatchQueued();
  }
  return;
}
```
`recovery` уже доступний у області видимості (створиється у `startAgentPlaneServer`).

### 6. Документація — `docs/ops/runbook.md`
Додати коротку нотатку в розділ repair/recovery: «Перезапуск агента тепер автоматично очищає leaked спроби (process restart виявляється через boot_id). Нема потреби чистити БД вручну.» (Також можу додати до `docs/dev/host-aware-local-fallback-plan.md` або відповідного recovery-документа, якщо є.)

### 7. Тести
**Контролер — `apps/controller/test/reconnect-reconcile.test.ts` (розширити) або новий `agent-boot-id-restart.test.ts`:**
- (а) Агент з 2 leaked `running` спробами + reconnect з НОВИМ boot_id → обидві спроби `completed/lost`, jobs `completed/agent_disconnected`. Контролер сховав новий boot_id.
- (б) Агент з 1 `running` спробою + reconnect з ТОЙ Ж boot_id (мережевий reconnect) → спроба НЕ зачеплена (все ще `running`). Доведено безпеку для живого процесу.
- (в) Агент без boot_id (старий агент, `boot_id=undefined`) → спроби НЕ зачеплені (back-compat).
- (г) Після очищення `activeJobsCount` агента = 0 → нова робота диспетчеризується (перевіряю через `getActiveJobsForAgents` або що `maybeDispatchQueued` підхоплює чергу). Використати `vi.useFakeTimers()` як у сусідніх тестах.

**Агент — `apps/agent/test/` (новий або розширити `lease-capacity-race.test.ts`-сусіда):**
- Перевірити, що `capabilities.boot_id` встановлюється і стабільний при реконструкції `AgentConnection` (якщо легко досяжно через існуючий харнес; інакше — юніт-перевірка, що `probeCapabilities` + run.ts встановлюють boot_id).

**Міграція — `apps/controller/test/migration-v4.test.ts` (новий):**
- Перевірити, що `last_boot_id` колонка додається, початкове NULL, SELECT/UPDATE працює (за зразком `migration-v3.test.ts`).

### 8. Фінальна перевірка
- `pnpm format` → `pnpm verify` (lint + unit + rust).
- Перебудувати `@rbo/protocol` dist (`pnpm --filter @rbo/protocol build`) → `pnpm typecheck` (controller), бо додано поле capabilities.

---

## Що НЕ змінюється
- Механіка `queued` стану, `tryDispatchQueuedJobs`, lease-sweep — не зачеплені.
- Recovery-семантика для мережевого reconnect (Case A) — повністю збережена (той самий boot_id → нульове втручання).
- Grace/orphan таймери при disconnect — лишаються як страхувальний запасний варіант (тепер вони майже ніколи не спрацюють для restart-випадку, бо `onAgentConnect` очищає миттєво).
- `process_identity` дочірніх процесів — окреме поняття, не конфліктує з boot_id процесу агента.

## Ризики / примітки
- **Перша версія — без міграційного shim для старих агентів без boot_id:** агенти, що не шлють `boot_id`, отримують back-compat-поведінку (очищення не тригериться; для них лишаються grace/orphan таймери). Це безпечно.
- **Leaked спроби → fail (lost), не ре-черга.** Якщо клієнт хоче повторити — він пересилає роботу (або вона вже в `queued` з попередньої фічі `default_queue_policy: wait`, але саме завдання, чиє завдання leaked, стає `completed/failed`). Це узгоджено з рішенням користувача «Fail (lost)» та з §Phase 3 «no auto-retry».
- Стовпець БД `last_boot_id` (варіант А) вимагає міграції v4 — але це чистіше за in-memory сховище, яке губиться при рестарті контролера.