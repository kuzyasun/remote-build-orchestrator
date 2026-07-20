# RBO — Handoff specs for Phase 3–8 implementation agents

Це шаблони завдань за зразком Appendix F дизайн-документа
(`remote-build-orchestrator-design.md`), адаптовані під поточний стан
репозиторію після Phase 0–2. Давайте агенту **одну секцію за раз** — коли
фаза прийнята (review пройшов), відкривайте наступну.

Кожна секція самодостатня: агент, який її отримує, не бачив попередніх
розмов і не повинен їх бачити — все потрібне контекстом нижче.

---

## 0. Спільні правила для будь-якого агента, що бере фазу (читати завжди)

```text
Repo: C:/projects/gemslibe/rm-builder
Design doc: remote-build-orchestrator-design.md (канонічний, нормативний §0)

Обов'язково прочитати перед правками: §0, §6.2, §13, §18, §29, §30, §34,
і повний текст Phase <N> у §35.

Робочий процес:
1. Дотримуйся TDD: спочатку тест, спостерігай RED (реальний фейл, не помилка
   імпорту), потім мінімальний код, GREEN. Ніколи не пиши тест після коду.
2. Zod-схеми у packages/protocol і packages/snapshot — єдине джерело правди.
   Якщо потрібне нове поле в контракті — редагуй схему там, а не роби
   локальну копію в apps/*.
3. Нова persisted структура → нова migration версія у
   apps/controller/src/storage/migrations.ts (додай запис у MIGRATIONS[],
   НЕ редагуй існуючі up/down існуючих версій).
4. Categoriзація помилок — лише через packages/shared/src/errors.ts
   (ErrorCategorySchema). Якщо потрібна нова категорія — додай туди, і вона
   автоматично підхопиться в packages/protocol/src/schemas.ts (re-export).
5. Тести можуть імпортувати src іншого apps/* пакета через relative path
   (є прецеденти: apps/controller/test/agent-connection.test.ts імпортує
   '../../agent/src/connection/client.js'). Це нормальний паттерн у цьому
   репо, не потрібно робити з цього окремий npm-пакет.
6. vitest.config.ts вже аліасить @rbo/shared, @rbo/protocol, @rbo/snapshot,
   @rbo/testing на їх src/index.ts — тести бачать актуальний код без build.
   Якщо додаєш новий package, додай його туди ж.
7. Перед тим як вважати фазу завершеною:
   - `pnpm lint` (biome, з увімкненим linter+organizeImports) — 0 помилок;
   - `pnpm build` — усі 8+ пакетів компілюються;
   - `pnpm test` (vitest) — усі тести зелені, включно з новими;
   - якщо торкався native/windows-executor — `pnpm rust:verify`;
   - `pnpm verify` як фінальний gate, exit code 0.
8. Не реалізовувати наступну фазу. Якщо чогось не вистачає з попередньої
   фази (не мала бути готова, але потрібна) — задокументувати як blocker,
   не мовчки доробляти чужу фазу.
9. Не слабшати security/path/secret/confirmation policy заради простоти
   реалізації.
10. Не створювати другу flat-схему для CLI/MCP — використовуй canonical.
11. Platform-sensitive тести на цьому хості (Windows). Багато "OS-specific"
    required tests (newline у filename, symlink escape/absolute-target
    rejection, executable bit, case collision) НАСПРАВДІ тестують чисту
    validation/parsing логіку, а не поведінку OS — розділяй "decide" від
    "execute": пиши validateSymlinkTarget/parseGitStatusLine/deriveGitMode
    тощо як PURE functions і годуй їх синтетичним byte-літералом прямо в
    тесті (напр. NUL-separated porcelain-v2 рядок з embedded \n, або
    exec-режим через `git update-index --chmod=+x` — це index-level
    metadata, не залежить від NTFS permission bits, коли core.filemode=
    false). Це працює однаково на Windows/Linux/macOS, БЕЗ skip і БЕЗ
    committed git-bundle fixtures (вони дрейфують від реального git-виводу
    і не допомагають genuinely OS-level тестам взагалі — не використовуй
    їх як загальну стратегію).
    Лише те, що є СПРАВЖНЬОЮ поведінкою ядра ОС (Unix process-group
    kill vs Windows Job Object, реальна POSIX symlink-семантика, якщо
    підтверджено що NTFS справді відмовляється створити конкретний
    артефакт) — гейтуй через `it.skipIf(...)` з тегом-коментарем
    `// PLATFORM-GAP: <причина> — verify on a Unix/macOS runner`.
    Перед тим як ставити skip — СПРОБУЙ реально (не припускай з folk
    knowledge); skip обґрунтований лише підтвердженим фейлом на цьому
    хості, задокументованим у коментарі.
    Звіт про завершення фази MUST включати grep-список усіх
    `PLATFORM-GAP` тегів як явний "known gaps" розділ — це запобігає
    тихому приховуванню реальних дірок за skip-count.
12. Numeric defaults (token TTL, artifact limits, window cap, cleanup
    timeout, max_concurrent_jobs тощо) — НЕ пінуються тут. Де design
    (§26.1) вже дає якір — реюзни (max_concurrent_jobs=1;
    artifact-лімати можуть стартувати від snapshot max_total_size_mb/
    max_file_size_mb). Де якоря немає — обери сам, задокументуй як
    config key поруч із кодом, що його споживає. Review перевіряє
    sanity і консистентність одиниць вимірювання між tasks, не точні
    числа.
13. Git fixture harness і §0.2 invariant differ — ОДНЕ місце, не
    duplication per task. Канонічна локація:
    `packages/testing/src/git-fixtures.ts`, експортований через
    `packages/testing/src/index.ts` (пакет уже aliased у
    vitest.config.ts). API (пінований, не переобирати):
      createGitFixtureRepo(spec: GitFixtureRepoSpec): GitFixtureRepo
        — спека: committed/staged/unstaged/untracked/deleted/ignored
        файли + gitConfig. mode='100755' реалізуй через
        `git update-index --chmod=+x`, mode='120000' — через
        `git hash-object -w --stdin` + `update-index --cacheinfo
        120000,<sha>,<path>` (§0 п.11 — index-level, не fs.chmod/
        fs.symlinkSync, працює однаково на Windows/Linux/macOS без
        skip і без реальних OS symlink-прав).
      captureGitState(repoRoot): GitStateSnapshot  — { head, branch,
        statusPorcelain, indexTree (git write-tree) }
      assertGitStateUnchanged(before, after): void — кидає з чітким
        diff-message при розбіжності; ЦЕ і є §0.2 invariant check.
    Хто пише: та задача, яка першою реально потребує (найімовірніше —
    execution core, бо invariant differ потрібен їй найраніше й
    найконкретніше — навколо запуску script), і пише ЦЕ ПЕРШИМ, до
    решти своєї роботи — сам harness не залежить від execution/runner
    internals, тож немає причини відкладати. Якщо інша задача дійде до
    потреби раніше — створює файл САМЕ за цим API, не ad hoc локальну
    версію. Review MUST перевірити, що існує рівно один такий файл
    (жодної другої копії під іншим ім'ям/локацією) — критичний
    invariant-check, розсинхронізовані копії неприпустимі.
    Ця ж канонічна локація застосовна і до майбутніх фаз (Phase 5
    golden-tree-hash fixtures, Phase 6 "два attempts не змішуються") —
    не переоцінюй рішення там, розширюй той самий файл.

Завершуючи фазу, агент MUST:
1. Виконати кожен deliverable фази або явно задокументувати blocker.
2. Додати кожен required test (позитивний і негативний) зі списку фази.
3. Самостійно зробити review: перечитати змінені файли, звірити з §0
   інваріантами, переконатись що жоден existing test не був "підправлений"
   лише щоб пройти (якщо existing test змінено — пояснити чому в звіті).
4. Запустити `pnpm verify` і вставити фінальний вивід (exit code) у звіт.
5. Написати короткий звіт: змінені файли, які тести додані, результати,
   відомі обмеження/borderline рішення, залишкові ризики.
6. Не починати наступну фазу.
```

---

## Поточний стан репозиторію (після Phase 0–2) — контекст для Phase 3

Це не частина design-документа, а фактичний знімок коду станом на момент
хендоффу, щоб Phase 3 агент не витрачав час на дослідження очевидного.

```text
packages/shared/src/
  errors.ts          — ErrorCategorySchema (§30), RboError
  ids.ts              — generateId/isValidId/parseIdPrefix, префікси:
                          job, att, agt, snp, art, lease, msg, req
  hashing.ts          — sha256()
  paths.ts            — normalizePath, isPathContained (ЛИШЕ лексичний
                          check, TODO(Phase 3) real-path/symlink escape —
                          саме це Phase 3 має закрити), normalizeRepositoryUrl
  crypto.ts           — Ed25519 keypair, EdDSA JWT sign/verify, nonce sign/verify
  controller-identity.ts — ensureControllerIdentity() — TLS cert + signing keys,
                          чисто fs/crypto, без DB-залежності

packages/protocol/src/
  schemas.ts          — JobRequestSchema (канонічний, §13.1), ExecutionConfigSchema
                          (shell enum bash/zsh/sh/powershell/pwsh/cmd/direct),
                          CompletionPolicySchema (run_to_exit/run_for_duration/
                          run_until_log_match), SourcePolicySchema (block/warn/allow),
                          JobAdditionalRootSchema, AgentCapabilityReportSchema
  messages.ts         — WireMessageEnvelopeSchema з job-scoped lease-полів
                          enforcement, Agent/Controller message type enums
  mcp-tools.ts        — MCP_TOOL_DEFS: ЛИШЕ agents_list, job_get, job_wait,
                          job_logs, job_cancel, job_artifacts,
                          artifact_materialize, agent_probe.
                          ⚠ job_submit і job_confirm ЩЕ НЕ ЗАРЕЄСТРОВАНІ —
                          це навмисно (Phase 1 не мала execution backend),
                          але Phase 3 MUST додати їх сюди.

packages/snapshot/src/index.ts
  — SnapshotManifestSchema: discriminated union за payload.mode
    (full | git_overlay) точно за §11.4/§12.1. `full` варіант вимагає
    source.files, repo — опційний (partial base_commit). git_overlay
    вимагає repo.base_commit + overlay.files/deletions. Файли — Git-режими
    як рядки "100644"/"100755"/"120000", symlink має `target`.
  — SnapshotInstanceSchema: snapshot_id/content_id/captured_at ОКРЕМО від
    канонічного маніфесту (§11.16 — runtime metadata не входить у content_id).
  ⚠ Немає ЖОДНОЇ реальної capture-логіки (git status parsing, overlay
    builder, archive, secret-policy matcher) — лише схеми. Це Phase 3+5.

apps/controller/src/
  config.ts           — loadControllerConfig (dataDir, mcpHost/Port,
                          agentPlanePort), resolveDefaultDataDir
  storage/database.ts  — openDatabase (better-sqlite3, WAL, foreign_keys ON),
                          migrateUp/migrateDown/migrateToLatest,
                          getSchemaVersion (PRAGMA user_version)
  storage/migrations.ts — MIGRATIONS[]: v1 initial-schema (agents,
                          job_submissions, jobs, job_attempts, job_events,
                          snapshots, artifacts — точно §25.2), v2
                          pairing-and-credentials (pairing_requests,
                          agents.device_public_key/thumbprint/
                          credential_version/revoked_at)
  jobs/submissions.ts   — reserveSubmission/completeSubmission/getSubmission
                          (ідемпотентність client_id+client_request_id, §11.2.1)
  jobs/service.ts       — getJob(db, jobId) — READ ONLY, немає createJob/
                          updateJobState/attempts CRUD ще. Phase 3 має додати.
  agents/service.ts     — listAgents (для agents_list tool)
  agents/registry.ts    — revokeAgent, updateAgentCapabilities, setAgentState
  security/identity.ts  — (видалено, перенесено в packages/shared) —
                          ControllerIdentity тепер з @rbo/shared
  security/pairing.ts   — createPairingRequest/approvePairingRequest/
                          rejectPairingRequest/claimApprovedPairing
  security/credentials.ts — issueAgentCredential/verifyAgentCredential/
                          markAgentSeen
  websocket/server.ts   — startAgentPlaneServer: TLS WSS на /agent,
                          hello/pairing_request/challenge_response/
                          capabilities/heartbeat, connectedAgents: Map
  http/server.ts        — startControllerServer: /mcp (Streamable HTTP),
                          /internal/v1/tools/* (stdio proxy backend),
                          /internal/v1/admin/* (CLI backend), loopback-only
                          enforcement (§7.1)
  http/admin.ts         — handleAdminRequest: pairing/list|approve|reject,
                          agents/list|revoke|probe (probe шле
                          refresh_capabilities push, або 409 agent_lost)
  mcp/handlers.ts        — handleToolCall: agents_list і job_get реальні;
                          job_wait/job_logs/job_cancel/job_artifacts/
                          artifact_materialize/agent_probe — усі повертають
                          not_implemented з details.planned_phase (3 або 2).
                          ⚠ Phase 3 замінює ці стаби реальною логікою для
                          job_wait/job_logs/job_cancel/job_artifacts/
                          artifact_materialize (local/isolated jobs), і
                          додає job_submit/job_confirm.
  mcp/server.ts          — buildMcpServer: реєструє всі MCP_TOOL_DEFS з
                          shared registry на McpServer instance
  main.ts                — entry point: db + identity + agent plane + http

apps/agent/src/
  config.ts              — loadAgentConfig (controllerUrl, fingerprint,
                          displayName, maxJobs, stateDir)
  capabilities/probe.ts  — probeCapabilities: реальний OS/CPU/RAM probe,
                          shells detection, git version; toolchain_profiles
                          завжди [] (Phase 4/5), disk_free_mb=0 TODO(Phase 3)
  connection/client.ts    — AgentConnection: pairing/auth flow, hello,
                          challenge_response, capabilities, heartbeat.
                          ⚠ Немає ЖОДНОЇ job-execution логіки — лише
                          з'єднання і автентифікація. Це буде Phase 4
                          (remote execution), НЕ Phase 3 (Phase 3 —
                          Controller-local execution, Agent не потрібен).
  main.ts                 — reconnect loop з heartbeat

apps/cli/src/commands/
  controller.ts           — runControllerInit/runControllerFingerprint
  agents.ts               — HTTP-клієнт до /internal/v1/admin/*
  service.ts               — renderServiceInstallPlan/renderServiceUninstallPlan
                          (dry-run, друкує команди, НЕ виконує — свідоме
                          обмеження, задокументоване в Phase 2 звіті)
  doctor.ts                — git/data_dir/shells/controller_reachable checks
apps/cli/src/main.ts        — dispatcher: controller, agents, agent,
                          doctor, submit/logs/cancel (зараз друкують
                          "not available yet" — Phase 3/4 мають замінити
                          хоча б submit на реальний виклик MCP internal API)

native/windows-executor/
  src/lib.rs               — ExecutionRequest/ExecutionResponse з
                          protocol-версією (PROTOCOL_VERSION=1),
                          parse_request/format_response. ⚠ ЛИШЕ парсинг
                          JSON — немає жодного реального spawn/Job Object
                          коду. main.rs — заглушка (println!). Це Phase 3
                          має реалізувати для Windows containment.

Тести (усі проходять, pnpm verify exit 0):
  packages/protocol/test/protocol.test.ts   — 39 тестів схем
  packages/snapshot/test/snapshot.test.ts    — 7 тестів манфесту
  packages/shared/test/crypto.test.ts        — 7 тестів crypto
  apps/controller/test/storage.test.ts       — migrations/FK
  apps/controller/test/idempotency.test.ts   — submissions
  apps/controller/test/transports.test.ts    — MCP stdio/HTTP рівність,
                                              loopback enforcement
  apps/controller/test/security.test.ts      — identity/pairing/credentials
  apps/controller/test/agent-connection.test.ts — WSS pairing e2e, replay,
                                              file permissions
  apps/controller/test/admin-api.test.ts     — admin HTTP API
  apps/cli/test/*.test.ts                    — CLI команди

Node: v24.11.1 (node:zlib має zstdCompressSync/zstdDecompressSync —
нативна підтримка zstd без зовнішньої залежності, перевірено робочим на
цій машині). Rust: 1.93.0. pnpm: 10.5.2. better-sqlite3, ws, selfsigned,
@modelcontextprotocol/sdk, ulid вже встановлені де потрібно.
```

---

## Phase 3 — Stable snapshot і isolated local execution

```text
Implement only Phase 3 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §6.2, §11 (increasingly §11.2.1, §11.6-§11.12, §11.16), §12.1,
   §13, §14, §15, §18, §22, §23.2, §23.2.1, §23.7, §23.8, §28.2, §29, §30,
   §34.1, §34.5 (лише path/archive-пункти, не lease/token — ті Phase 4),
   Appendix C, Appendix D (лише materialize для payload.mode=full), Appendix E.
2. Прочитай розділ "Поточний стан репозиторію" вище — там точно вказано,
   які файли вже є і що конкретно бракує.
3. НЕ читай і не торкайся Phase 4/5/6/7/8 розділів §35 — вони не для цієї
   задачі.
4. У working tree ВЖЕ Є частковий Phase 3 WIP (lifecycle CRUD у
   apps/controller/src/jobs/, submit flow, apps/controller/src/execution/
   runner.ts та інше). Це РЕЖИМ audit + relocate + gap-fill, НЕ
   clean-room переписування з нуля. Working, вже покритий тестами код —
   НЕ викидати без конкретної причини. Перший крок будь-якого task:
     a. прочитати відповідні існуючі файли;
     b. звірити САМЕ ПРОТИ ДВОХ рішень, зафіксованих нижче в цьому
        документі (confirmation_token = EdDSA JWT, execution driver =
        fire-and-track + Map<attempt_id,...>) — це найризиковіші точки
        drift, бо частина WIP могла бути написана до пінінгу цих рішень;
        якщо код розходиться з пінами — це MUST fix, не "залишити як є";
     c. короткий список "existing / matches decision / drift-needs-fix /
        missing" ДО написання нового коду;
     d. лише після цього — gap-fill відсутнього і релокація виконавчого
        коду з apps/controller/src/execution/ у packages/executor (щоб
        apps/agent міг реюзнути його в Phase 4 без дублювання
        платформо-специфічного коду, §0.1 rule 10) — робити ЦЕ ЗАРАЗ, у
        межах Phase 3, а не відкладати на Phase 4: механічний move+
        import-fix під контролем існуючих тестів дешевший зараз, ніж
        коли Phase 4 муситиме одночасно переносити код і будувати на
        ньому нову Agent-side логіку.

Scope (тільки те, що design явно кладе в Phase 3 — full snapshot payload
mode, ЛОКАЛЬНЕ isolated виконання; git_overlay/mirror і remote Agent
execution — це Phase 4/5, НЕ роби їх):

Розбиття на 4 tasks і граф залежностей (РІШЕННЯ, зафіксовано, не
переобирати) — Diamond, НЕ строгий лінійний ланцюжок:

```
Task 1 (lifecycle CRUD foundation)
   │
   ├──▶ Task 2 (materialize + Unix script exec + logs/artifacts +
   │            git-fixtures harness + packages/executor scaffold)
   │
   └──▶ Task 3 (Windows Rust Job Object adapter, кодить проти вже
                піненого EventEmitter/binary-frame контракту)
                │
   Task 2 і Task 3 — ПАРАЛЕЛЬНО, обидва залежать лише від Task 1.
                │
   {Task 2, Task 3} ──▶ Task 4 (job_submit/job_confirm + MCP backends)
```

Правила, що роблять цей паралелізм безпечним (а не просто швидким):
- `packages/executor` scaffold (package.json/tsconfig.json/index.ts з
  лише піненим TS-інтерфейсом EventEmitter-адаптера, без реалізації) —
  пише Task 2 як буквально ПЕРШИЙ крок, до Unix exec-логіки, поряд з
  git-fixtures harness (§0 п.12) — теж "спершу plumbing, потім логіка".
  Це малий механічний крок; Task 3 (Cargo/Win32 API research) фізично
  не встигне дійти до потреби в @rbo/executor раніше.
  Fallback за реального race: якщо Task 3 дійде першим — створює
  scaffold сам, точно за контрактом, піненим нижче в цьому документі;
  позначає це в звіті; review перевіряє відсутність дублю.
- Review MUST явно звірити, що реалізації Task 2 (Unix) і Task 3
  (Windows) ОБИДВІ буквально відповідають піненому EventEmitter/frame
  контракту — розбіжність інакше виявиться найдорожче: на інтеграції
  в Task 4.
- Task 4 жорстко залежить від Task 1 і від ІНТЕРФЕЙСУ packages/executor
  (може писати job_submit/confirm код одразу після Task-2-скаффолда,
  не чекаючи повної Unix-реалізації) — але його end-to-end тести на
  цьому Windows-хості реально гейтовані завершенням САМЕ Task 3 (Unix
  kill-test тут і так PLATFORM-GAP, §0 п.11), не Task 2.
- Task 3's Windows Job Object kill-test лишається PLATFORM-GAP-кандидатом
  НЕЗАЛЕЖНО від порядку виконання задач, якщо sandboxed-середовище не
  дозволяє реального Job Object — задокументувати за правилом §0 п.11,
  не підробляти passing test.

Deliverables:
1. Cooperative snapshot lock і stable-read capture (§11.2.1):
   - packages/snapshot/src/git-status.ts: обгортка над
     `git status --porcelain=v2 -z --untracked-files=all`,
     `git rev-parse HEAD`, `git symbolic-ref --short HEAD` (branch може
     бути null у detached HEAD), парсинг NUL-separated виводу.
   - packages/snapshot/src/secret-policy.ts: default denylist з §11.12
     (.env, .env.*, *.pem, *.key, *.p12, *.pfx, id_rsa, id_ed25519,
     credentials.json, secrets.*, .aws/, .ssh/), режими block/warn/allow
     (SourcePolicySchema вже має ці 3 значення — реюзай).
     РІШЕННЯ (зафіксовано, не переобирати): block = hard-fail усього
     capture — structured `secret_blocked` error зі списком offending
     paths, жодний snapshot/content_id не публікується, partial temp
     content purged (той самий шлях, що workspace_changed purge). warn =
     capture проходить, файл INCLUDED, `secret_warning` JobEvent на
     кожен match. allow = capture проходить мовчки. НЕ виключай
     denylisted файли з manifest при block (це зламало б "exact dirty
     snapshot" — build поводитиметься інакше, ніж реальне дерево
     розробника, тихо і непомітно) — §0 rule 9 forbids це заради
     зручності.
   - packages/snapshot/src/capture.ts: captureFullSnapshot(input) —
     реалізує алгоритм з Appendix C ЛИШЕ для payloadMode="full":
       a. resolve project root, ПЕРЕВІРИТИ allowed root через REAL path
          (fs.realpath), не лексично — symlink/junction escape має провалитись;
       b. зняти "перший знімок" file identity tuples (path, size, mtime,
          type; де є — inode/fileId) для git-tracked + untracked
          non-ignored + explicit include_ignored files;
       c. прочитати кожен файл РІВНО ОДИН РАЗ у temporary content storage
          (напр. під controller data dir), одночасно рахуючи sha256;
       d. застосувати secret policy до кожного прочитаного файла;
       e. повторно знята git status/HEAD/file-identity tuples;
       f. якщо щось змінилось (HEAD, набір шляхів, type/size/mtime/fileId)
          → видалити partial capture, кинути помилку категорії
          "materialization" з detail workspace_changed (див. нижче про
          RboError category — можеш або реюзнути "materialization", або
          додати нову категорію "workspace_changed" в
          packages/shared/src/errors.ts ErrorCategorySchema, це дозволено
          §35.1 rule 2 — спершу схема, потім споживачі);
       g. лише після успішної re-перевірки — canonical manifest (§11.16:
          без created_at/hostname/job_id), content_id = sha256 канонічного
          манфесту, і збудувати SnapshotManifestSchema (payload.mode=full,
          source.files, additional_roots).
   - packages/snapshot/src/archive.ts: tar+zstd архів captured content.
     Використай `node:zlib` zstdCompressSync/zstdDecompressSync (перевірено
     доступні в цьому Node) або пакет `tar` для tar-структури + вбудований
     zstd для стиснення. НЕ використовуй зовнішній zstd CLI-біндінг, якщо
     вбудованого зistdCompressSync вистачає для MVP-розміру файлів.
   - Explicit empty-directory markers (§11.2) — якщо платформа/архів-формат
     не підтримує явний маркер, capture MUST провалитись з
     "materialization", а не тихо пропустити.
2. Symlink policy (§11.8): absolute symlink — заборонено; symlink, що
   виходить за workspace — заборонено; ціль зберігається як текст; на
   Windows без symlink support — `symlink_unsupported`, без copy fallback.
3. Isolated local materialization (§28.2): controller матеріалізує snapshot
   у власний isolated workspace (не в реальний project root), той самий
   код шляху, що majбутній Agent-side materializer використає в Phase 4 —
   тримай його платформо-незалежним у packages/snapshot або
   apps/controller/src/execution/materialize.ts.
4. Script-first execution (§13.2, §15, Appendix E):
   - Env-контракт (РІШЕННЯ, зафіксовано): інжектуй RBO_JOB_ID,
     RBO_ATTEMPT_ID, RBO_WORKSPACE, RBO_ARTIFACTS_DIR, RBO_LOG_DIR у
     child env; ExecutionConfig.env мержиться під ними. Префікс `RBO_` —
     зарезервований, user-ключ з цим префіксом НЕ перекриває інжектовані
     значення (ignore + warning event, не error) — RBO_* завжди win.
     Причина: Phase 7 Docker/Compose labeling і audit trail покладаються
     на ці ідентифікатори як на джерело правди для власного скрипта;
     дозволити user env перекрити їх means script може підмінити свій
     власний RBO_JOB_ID — той самий клас проблеми, що §0 rule 9 забороняє
     для secret policy, тепер для env boundary.
   - bash, powershell, direct shells (§13.3 повний список shell-ів вже в
     схемі, але Phase 3 реалізує лише bash/powershell/direct — sh/zsh/cmd/
     pwsh можуть чекати, якщо часу не хватає, задокументуй як gap, не
     провалюй фазу через це);
   - Controller пише script file в .rbo/job.sh або .rbo/job.ps1 у
     workspace, запускає з відповідним інтерпретатором;
   - timeout_seconds, idle_timeout_seconds, cancel_grace_seconds з
     ExecutionConfigSchema — усі мають реально працювати;
   - Unix process group containment (setsid/process group + SIGTERM →
     grace → SIGKILL групі);
   - Windows: RUST HELPER MUST реально працювати — заповни
     native/windows-executor/src/main.rs: створити Job Object з
     kill-on-close, spawn дочірній процес suspended, додати в Job Object,
     resume, graceful cancel → terminate Job Object.
     Streaming wire-контракт helper→Node (РІШЕННЯ, зафіксовано, не
     переобирати): length-prefixed binary frames на stdout helper-а, НЕ
     line-delimited JSON+base64. Формат кожного frame:
       [1 byte tag: 0x01=stdout, 0x02=stderr, 0x03=control]
       [4 bytes LE u32 payload length]
       [N bytes payload]
     tag 0x01/0x02 — сирі байти точно як прочитані з OS pipe дочірнього
     процесу, БЕЗ жодної трансформації і БЕЗ вирівнювання межі frame по
     newline у даних дитини (межа — довільна, за розміром read-буфера).
     tag 0x03 — останній frame у потоці: JSON-байти ExecutionResponse
     (exit_code/success/timed_out/error_message), helper завершується
     після нього.
     Причина: §29.5/§29.6 (Phase 4) вимагають exact-value redaction через
     межі chunks — потрібні сирі байти без decode-step, а не base64+JSON
     на кожен chunk (~33% overhead + parse-cost, який Phase 6 "1 GB logs"
     зробить реальною проблемою, якщо закладено неправильно зараз).
     Control-повідомлення (рідкі, малі) лишаються JSON-байтами всередині
     tag-0x03 frame — це дає debuggability JSON там, де вона безкоштовна,
     без overhead на bulk-даних.
     Версіонування: helper і Node-адаптер деплояться як пара з одного
     build'у (не незалежно через мережу) — НЕ роби min/max negotiation
     типу negotiateProtocolVersion; просто бампни PROTOCOL_VERSION з 1 на
     2 в lib.rs, exact-match перевірка (вже є в parse_request) лишається
     правильною моделлю.
     Node-адаптер (packages/executor): обгорни frame-reader так, щоб він
     виглядав як звичайний ChildProcess-подібний EventEmitter
     (.stdout.on('data', chunk => ...), .stderr.on('data', ...),
     .on('exit', ...)) — той самий shape, що Unix child_process.spawn
     має природно, щоб logSpool/cancellation/cleanup-код (Appendix E)
     працював однаково незалежно від платформи; платформо-специфічний
     код лишається лише в самому frame-reader'і (§0.1 rule 10).
     Напиши Rust integration test: child спавнить grandchild, після
     cancel обидва процеси відсутні (§15.2 явно вимагає цей тест). Якщо
     збірка/тест реального Windows Job Object неможливі в поточному
     sandboxed-середовищі виконання — задокументуй ЯК ТОЧНО ти це
     перевірив (напр. локально поза sandbox) і залиш чіткий TODO, не
     вигадуй фейковий "passing" тест, який нічого не перевіряє;
   - cleanup_script виконується після success/failure/timeout/cancel/
     execution error (§15.3). РІШЕННЯ (зафіксовано): cleanup-помилка НЕ
     змінює outcome (§18.1 — outcome відображає основний script, cleanup
     — auxiliary). Пиши `cleanup_error` JobEvent (exit code/timeout) —
     той самий discriminated union, що вище. Cleanup має власний bounded
     timeout (cancel_grace_seconds або окрема межа), force-kill тим самим
     process-group/Job-Object шляхом.
5. Local append-only logs (§21.3 підмножина — без network spool/ack, це
   Phase 6): stdout.log/stderr.log/events.jsonl.
6. Artifact collection (§22.1-§22.3 підмножина без remote upload):
   glob-based scan, max file count/size configurable з дефолтами, SHA-256
   кожного файла, директорії архівуються, symlink artifacts заборонені.
   Limit-breach handling (РІШЕННЯ, зафіксовано): outcome НІКОЛИ не
   змінюється через collection-проблеми (§18.1 не має "collection error"
   у outcome vocabulary; §18.2 collecting_artifacts→cleaning — безумовний
   перехід) — той самий принцип, що й cleanup_script вище. Один файл над
   max-single-file-size, або symlink artifact → skip лише його,
   `artifact_skipped` event, collection триває. Aggregate breach (total
   count/size — tar-bomb-клас ризику з §34.5) → зупинити collection,
   видалити вже зібране для цього attempt (не публікувати partial set,
   що виглядає повним — той самий принцип, що workspace_changed purge),
   `artifact_limit_exceeded` event з деталями. job_artifacts повертає
   пусто для цього attempt; причина видна через job_logs/events.

   Physical layout і lifecycle (РІШЕННЯ, зафіксовано, не переобирати):
   persistent logs/+artifacts/ per attempt, ephemeral workspace видаляється
   одразу після collection. НЕ content-addressed store з dedup — §3
   "Нецілі першої версії" і §38 "Майбутні розширення" ЯВНО називають
   "blob-level dedup" post-MVP; CAS+ref-counting зараз — premature.
     <dataDir>/attempts/<attempt_id>/workspace/    — ефемерний
     <dataDir>/attempts/<attempt_id>/logs/         — persistent
     <dataDir>/attempts/<attempt_id>/artifacts/    — persistent
     <dataDir>/attempts/<attempt_id>/control/      — ефемерний (job.sh/job.ps1)
   Control-файли (RBO-generated script, per-attempt state) — РІШЕННЯ
   (зафіксовано): sibling `control/` під attempt dir, НЕ `workspace/.rbo/`.
   Script invoked з cwd=workspace/, абсолютний шлях до control/job.sh.
   Artifact globs рутовані на workspace/ — control/ фізично недосяжний
   для них, без exclusion-правил, які легко забути в одному з glob-шляхів.
   Уникає collision з user dirty tree, що вже міг мати власний `.rbo/`.
   Ключ — attempt_id (глобально унікальний ULID), НЕ job_id — не додавай
   зайвого вкладення під job_id; якщо у WIP вже є attemptLogDir(dataDir,
   attemptId), НЕ змінюй цю конвенцію — додай workspace/ і artifacts/ як
   siblings до вже існуючого logs/ під тим самим attempts/<attempt_id>/.
   Ця структура узгоджена з Appendix B (Agent workspace layout, той самий
   principle: logs/+artifacts/ на рівні attempt, окремо від ефемерного
   project/) — Phase 4/5 Agent-side materialization матиме ту саму форму,
   без потреби узгоджувати дві різні схеми пізніше.
   Cleanup timing: workspace/ видаляється СИНХРОННО, одразу після
   artifact collection + cleanup_script, НЕЗАЛЕЖНО від outcome
   (succeeded/failed/timed_out/cancelled — §22.2: artifacts збираються
   навіть після failure), прив'язано до переходу collecting_artifacts→
   cleaning (§18.1), не до таймера; видалення — idempotent/best-effort
   (rmSync recursive+force). logs/ і artifacts/ переживають видалення
   workspace і НЕ видаляються в Phase 3 взагалі — retention/expiry
   (§26.1 приклад: retention.successful_jobs_days/failed_jobs_days/
   artifacts_days) — явний Phase 6 scope, Phase 3 лише гарантує стабільну,
   адресовану за attempt_id директорію для майбутнього GC.
   Копіювання artifacts з workspace: використовуй fs.rename (move), не
   copy+delete, коли workspace/ і artifacts/ на тому самому volume (вони
   завжди будуть, обидва під одним dataDir) — уникає зайвої I/O-копії.
   Required test (додай явно в Phase 3, не відкладай на Phase 6): дві
   attempts одного job (retry) не змішують workspace/logs/artifacts —
   директорія другого attempt не залежить і не перезаписує директорію
   першого.
7. `job_submit` MCP tool (§23.2) — ДОДАЙ до
   packages/protocol/src/mcp-tools.ts (JOB_SUBMIT_INPUT = JobRequestSchema
   forma, реюзни existing z object). Controller-side:
   - ідемпотентність через jobs/submissions.ts (вже є reserveSubmission/
     completeSubmission) — НЕ переписуй цю логіку, інтегруй з нею.
     Синхронна capture-помилка (workspace_changed re-check провалився,
     secret-policy block) — РІШЕННЯ (зафіксовано, не переобирати):
     викликай completeSubmission(db, clientId, clientRequestId, 'failed',
     errorPayload) БЕЗ jobId (параметр опційний, лишається NULL — цей
     механізм уже є з Phase 1, нічого не додавай у submissions.ts).
     Жоден jobs-рядок НЕ створюється (§18.2 стейт-машина не має ребра
     "created→failed-before-queued"; created існує лише як наслідок
     успішного capture). Клієнт бачить структуровану RboError inline, у
     тій самій відповіді job_submit — job_id не повертається, polling не
     потрібен (capture-помилка стається до завершення call'у, ADR §4.3).
     Retry: клієнт МАЄ використати НОВИЙ client_request_id (§11.2.1 explicit
     текст: "повторює job_submit із новим client_request_id") — НЕ той
     самий. Причина не стилістична: completeSubmission уже робить
     captured/failed immutable для ключа (Phase 1, протестовано) — повтор
     ТОГО САМОГО ключа після failed завжди поверне закешовану стару
     помилку, ніколи не спробує capture повторно. Новий ID — єдиний спосіб
     otримати нову спробу, це наслідок механізму, не окрема policy.
     (Той самий "той самий ключ = той самий network request, невідомий
     клієнту outcome" сценарій — розрив з'єднання до response — лишається
     тим самим ключем, це інший, не суперечливий випадок: клієнт не знає
     результату і перевіряє його, а не свідомо повторює після explicit error.)
     Додай категорію `workspace_changed` в ErrorCategorySchema
     (packages/shared/src/errors.ts) — §35.1 rule 2, спершу схема. НЕ
     overload existing `materialization` для цього — design називає
     workspace_changed за іменем у §11.2.1/§23.2/§37, це client-actionable
     категорія, яка заслуговує на власне ім'я для матчингу на клієнті.
     `secret_blocked` категорія вже існує — реюзни;
   - safe/normal → одразу queued → capture snapshot → materialize →
     execute (синхронно "локально" немає remote scheduler'а, це Phase 3
     виконує локально в Controller process, тому "queued"→"matching"→
     "leased" переходи для local executor можуть бути миттєвими/тривіальними,
     головне що стан у БД записаний коректно й послідовно за §18.1);
   - destructive/hardware → created → awaiting_confirmation, повертає
     confirmation_token. РІШЕННЯ (зафіксовано, не переобирати): підписуй
     EdDSA JWT через вже наявний packages/shared crypto
     (signEdDsaJwt/verifyEdDsaJwt, controller identity signing key з
     ensureControllerIdentity) — НЕ окремий HMAC-секрет. Причина:
     Phase 4 (§29.2) вимагає того самого EdDSA JWT механізму для
     attempt-scoped data tokens; використання одного паттерна зараз
     уникає дублювання/переписування пізніше, а signEdDsaJwt/
     verifyEdDsaJwt вже покриті тестами в
     packages/shared/test/crypto.test.ts — нового crypto-коду тут не
     потрібно, лише claims/binding.
     Claims: `sub`=job_id, `aud`=controllerId, `exp`=short-lived (кілька
     хвилин), плюс кастомні claims `request_hash` (sha256 канонічного
     request), `content_id` (snapshot.content_id), `risk_level`.
     На job_confirm: verifyEdDsaJwt() → ПОВТОРНО звір `claims.aud` з
     `identity.controllerId` (verifyEdDsaJwt сам aud не перевіряє —
     дивись, як це вручну зроблено в verifyAgentCredential, повтори той
     самий паттерн) → перерахуй request_hash/content_id/risk_level job'а
     і звір з claims; будь-яка розбіжність (змінили script/source) —
     токен інвалідний (§29.4);
   - job_submit tool call залишається відкритим ЛИШЕ до завершення
     snapshot capture (§4.3) — після цього повертає job_id і виконання
     йде асинхронно (job_wait/job_logs дальше опитують).
8. `job_confirm` MCP tool (§23.2.1) — ДОДАЙ до mcp-tools.ts. Перевіряє
   token expiry + binding (request hash, content_id, risk_level, agent
   selector), атомарно queued. Не створює новий snapshot.
9. Реалізувати реальний backend для (замінити not_implemented):
   - job_wait — polling job state з БД, timeout wait_seconds, tail logs;
   - job_logs — читає events/stdout/stderr з append-only логів на диску,
     cursor scoped до attempt_id (§23.5 — attempt_id=null → поточна/
     terminal attempt, MUST повернути resolved attempt_id);
   - job_cancel — сигналізує executor'у зупинити script (grace → force),
     не автоматично retry side-effecting job;
   - job_artifacts — читає artifacts table, групує за attempt_id,
     позначає terminal attempt;
   - artifact_materialize (§23.8) — копіює один artifact у
     allowed_artifact_destinations/allowed_project_roots шлях: перевірка
     real path усіх existing parent directories, default overwrite=false,
     temp file + hash verify + atomic rename, лог audit (client, artifact
     id, attempt id, destination, hash).
10. Job lifecycle persistence: додай CRUD у apps/controller/src/jobs/
    (createJob, transitionJobState, createAttempt, recordEvent тощо) —
    вони пишуть у jobs/job_attempts/job_events таблиці, що вже існують
    (migrations v1). НЕ міняй існуючу migration — якщо потрібні нові
    колонки, додай migration v3.
    events.jsonl / job_events shape (РІШЕННЯ, зафіксовано): canonical
    `JobEventSchema` в packages/protocol (discriminated union за event
    type: state_transition, snapshot_captured, materialized,
    process_started, artifact_collected, secret_warning,
    cancel_requested, error — реюзни ErrorCategorySchema для error).
    recordEvent пише лише через цю схему; job_logs повертає типізовані
    events, не opaque JSON. Не free-form — це wire-контракт до AI
    клієнтів, §35.1 rule 2 прямо вимагає єдиного джерела правди в
    packages/protocol для цього.
11. Execution-driver model. РІШЕННЯ (зафіксовано, не переобирати):
    lightweight fire-and-track runner, НЕ queue-table-driven worker loop.
    На queued/confirmed: синхронно запиши state transitions в DB, потім
    kick off detached async execution; тримай
    `Map<attempt_id, cancelHandle>` (КЛЮЧ — attempt_id, не job_id: retry
    створює новий attempt, а не перезаписує попередній, §18.2; job_cancel
    резолвить job_id → поточний attempt_id через getLatestAttempt(db,
    job_id), і лише тоді lookup у Map) у пам'яті процесу лише для
    job_cancel. DB лишається source of truth для job_wait/job_get polling
    — НЕ читай стан з Map для відповіді клієнту.
    Причина: queue+worker loop зараз вгадує форму Phase 4 scheduler'а
    (capability filtering, множинні agents, lease epoch fencing) наперед,
    без жодної з цих вимог у Phase 3 — класична premature abstraction;
    Phase 4 майже напевно матиме іншу форму, тож "менше переписування
    пізніше" від воркер-лупа ілюзорне. Concurrency cap (адмісія) закривай
    ОДНИМ guard перед spawn — `COUNT jobs WHERE state IN ('starting',
    'running') < config.local_executor.max_concurrent_jobs` (дефолт 1, за
    §26.1 прикладом local_executor.max_jobs) — а не окремою
    queued-table-driven машинерією. In-memory registry втрачається при
    restart Controller'а — це очікувано і ОДНАКОВО стосується будь-якої
    моделі (worker loop так само тримає in-flight/семафор state в
    пам'яті); реконсиляція — явний scope Phase 6 (§31.1), не Phase 3.
12. Automatic retry: РІШЕННЯ (зафіксовано) — НЕМАЄ автоматичного retry в
    Phase 3. Local runner завжди створює attempt з ordinal=1 і ніколи сам
    не спавнить другий attempt. Failed/timed-out/cancelled attempt →
    job переходить у terminal failed outcome; retry = нова job_submit
    (новий client_request_id) від клієнта. createAttempt/ordinal/
    lease_epoch колонки лишаються в схемі, використовуються тривіально —
    готові для Phase 4/6, де реальні drivers retry (lease loss, agent
    disconnect, epoch fencing) фактично існують. Не будуй retry-
    класифікацію (transient vs script-failure) зараз — Controller-local
    executor не має тих сценаріїв, під які §18.2 retry семантика
    написана; неправильна класифікація означає повторний запуск
    side-effecting script, а це саме те, що job_cancel-піни вже
    забороняють.

Required tests (мінімум, додай усі — і позитивні, і негативні):
- Snapshot unit tests з §34.1, підмножина застосовна до full mode:
  staged only, unstaged only, staged+unstaged same file, deletion,
  untracked, ignored, explicit ignored, binary, Unicode filename, spaces,
  newline in filename, executable bit, symlink, case collision, additional
  root, secret denylist, concurrent edit during capture →
  workspace_changed, HEAD change during capture → workspace_changed, file
  replacement with same path/size, source symlink escape.
  (git_overlay-специфічні: dirty submodule, git bundle — НЕ роби, Phase 5.)
- concurrent file modification повертає workspace_changed і НЕ публікує
  partial snapshot (перевір що temp content видалений);
- timeout/cancel прибирає child і grandchild (Unix точно; Windows —
  задокументуй метод перевірки, якщо sandbox обмежує);
- artifact materialization не виходить з allowed roots, не overwrite без
  explicit flag;
- destructive job не стартує без valid confirmation token;
- local source workspace і Git state (HEAD/branch/index) після job НЕ
  змінились (це фундаментальний інваріант §0.2 — обов'язково перевір
  автоматичним тестом, що виконує job проти fixture-репозиторію і звіряє
  git status до/після);
- два clients з однаковим client_request_id (різні client_id) не
  конфліктують (вже покрито Phase 1 тестом submissions.ts — переконайся,
  що job_submit end-to-end тест теж це підтверджує).

Exit criteria (§35): Codex або test MCP client запускає isolated local
build exact snapshot; після повернення job_submit source можна редагувати
без впливу на job.

Completion requirements: як у §0 вище (спільні правила).
```

### Phase 3 — status (review fixes, 2026-07-20)

Post-review gap-fill closed the acceptance blockers:

- **P0** `source.cwd` escape: Zod reject `..`/absolute + runtime `resolveContainedCwd`
- **P0** `additional_roots.mount_path` escape: same relative-path rules + lexical containment before mkdir
- **P1** completion policies: `run_for_duration` / `run_until_log_match` in runner
- **P1** log-match watcher: stop()/incremental byte scan (no leaked interval / full-log reload)
- **P1** `additional_roots.mode`: persisted in manifest; `read_only` applied via chmod after materialize
- **P1** capture guard: path-set + additional-root identity recheck
- **P1** additional roots: no tar dup; materialize at declared mount
- **P1** deterministic tar mtime → stable `content_id`
- **P1** admission semaphore (closes COUNT→async race) + queued/pre-start cancel
- **P1** `direct` shell: chmod + shebang / Windows `.cmd`
- **P1** Windows helper keeps reading stdin for `CANCEL`
- **P2** Job Object test fails if PID file missing

#### Known gaps (`PLATFORM-GAP` + Phase 3 shell scope)

```text
packages/snapshot/test/capture-scenarios.test.ts
  PLATFORM-GAP: creating FILE.txt + file.txt as distinct entries requires a
  case-sensitive FS — verify end-to-end capture rejection on a Linux runner.
  (Pure decision logic covered by findCaseCollisions unit tests.)

packages/snapshot/test/capture-scenarios.test.ts
  PLATFORM-GAP: symlink escape / absolute-target rejection scenarios that need
  real POSIX symlink semantics — verify on Unix/macOS runner where noted.

packages/executor/test/process-cancel.test.ts
  PLATFORM-GAP: Unix process-group kill requires POSIX setsid/SIGTERM semantics
  — verify on a Unix/macOS runner. Windows Job Object grandchild kill covered
  by native/windows-executor/tests/job_object_test.rs.

Shells: Phase 3 implements bash / powershell / direct only.
  Gap (documented, not phase-blocking): sh / zsh / cmd / pwsh
  (see packages/executor/src/script.ts PHASE3_UNSUPPORTED_SHELLS).
```

---

## Phase 4 — Remote full-snapshot execution

```text
Implement only Phase 4 from remote-build-orchestrator-design.md: remote
execution of `payload.mode=full` snapshots. The Controller remains the API
owner; the Agent is an authenticated, fenced worker. Do not implement Git
mirrors, overlays, resume/replay, or multi-Agent scheduling extensions here.

## Start gate

Do not edit Phase 4 code until all of the following are true:

1. Read §0, §9.1-§9.6, §12.2-§12.4, §18-§21, §29.2, §29.5-§29.6, §30,
   the non-repository-cache part of §34.2, and the Phase 4 tests in §35.
2. Phase 3 is accepted by its explicit exit criteria and `pnpm verify` is
   green. In particular, snapshot capture and materialization must reject
   traversal in every archive and additional-root path before an Agent is
   allowed to materialize a Controller-provided snapshot.
3. Inspect the existing Phase 3 execution, artifact, log, database, and
   snapshot APIs before adding a parallel implementation. Reuse their public
   job status, `job_wait`, and `job_artifacts` behaviour.

Read Phase 5 and Phase 6 only to understand the following boundaries; do not
implement any of their deliverables in this phase:

- Phase 5 owns Git mirrors, Git/bundle transfer, and `git_overlay` payloads.
- Phase 6 owns disk-spool ACK/replay, reconnect reconciliation, orphan
  adoption, and automatic retry/resume of interrupted remote attempts.
- Phase 4 sends live chunks only. A disconnected or expired remote attempt
  becomes terminal according to the Phase 4 lease policy; it is never resumed
  or adopted by a later connection.

## Fixed Phase 4 decisions

1. **Payload scope.** Support `payload.mode=full` only. Reject an attempt
   selected for any other payload mode with a structured, terminal error.
2. **One server, one port.** Use the existing TLS `https.Server` on port 7411.
   Route `/agent` upgrades to WebSocket and route only `/data/v1/*` HTTP
   requests to the data plane on that same server. Never create a second
   listener on the same port. The data plane must not expose MCP, pairing,
   admin, or Controller API routes.
3. **One active job per Agent.** The Phase 4 effective capacity is
   `min(capabilities.execution.max_jobs, 1)`. An Agent whose effective
   capacity is zero is not selectable. Do not add concurrent remote execution
   in this phase.
4. **No untyped job payloads.** The message-type enums in
   `packages/protocol/src/messages.ts` are names only. Before using a job
   message, add a discriminated Zod schema for its payload and make both
   Controller and Agent parse it. Do not use `Record<string, unknown>` at a
   job boundary.
5. **No secret value leaves the Agent.** `secret_refs` may travel in the job
   requirement, but secret values must never appear in the snapshot, SQLite,
   WebSocket payloads, HTTP URLs, logs, artifact metadata, events, or errors.

## Wire contract and attempt state machine

All job-scoped frames carry the envelope `attempt_id`, `lease_id`, and
`lease_epoch`. Define typed payloads, validation tests, and structured reject
reasons for at least: `lease_offer`, `lease_accept`, `lease_reject`,
`prepare_source`, `source_ready`, `run_job`, `cancel_job`, `job_started`,
`log_chunk`, `job_exit`, `artifact_manifest`, and `cleanup_complete`.

Use this lifecycle, persist every transition in the existing attempt storage,
and make every transition idempotent:

1. `queued` → `leasing`: Controller selects one Agent, generates and persists
   a new `lease_id`, monotonically increasing `lease_epoch`, and expiry.
2. `leasing` → `preparing`: Agent atomically reserves its sole slot and sends
   `lease_accept`; a reject releases no Controller state other than the offer.
3. `preparing` → `running`: Agent has downloaded, verified, atomically stored,
   and materialized the full snapshot, then sends `source_ready`; Controller
   may then send `run_job`.
4. `running` → `collecting` → terminal: Agent streams redacted logs, reports
   exit, uploads declared artifacts, and sends `cleanup_complete`. Controller
   exposes the same terminal state and artifacts as a local Phase 3 attempt.

The Agent accepts `prepare_source`, `run_job`, and `cancel_job` only for its
currently reserved `{agent_id, attempt_id, lease_id, lease_epoch}`. The
Controller accepts Agent logs, status, manifests, and cleanup only from the
authenticated Agent with the same tuple. Reject stale, duplicate, wrong-Agent,
or expired messages without changing state. A heartbeat renews only the active
lease. On lease expiry or connection loss, mark the attempt terminal as
`agent_disconnected`, release the slot, and do not retry, resume, or adopt it.

Extend `apps/agent/src/connection/client.ts` from its current pairing/auth
operation into a long-lived authenticated session: periodic heartbeats,
typed inbound command dispatch, one active attempt registry, and deterministic
cleanup on socket close. Do not put execution logic in WebSocket callbacks.

## Scheduling and fallback

Implement pure scheduler functions in `apps/controller/src/scheduler/`, with
unit tests independent from WebSocket and SQLite. Hard-filter Agents by
required OS, architecture, labels, minimum memory/disk, named secret refs,
and a concrete matching toolchain profile. Resolve each requested tool to a
profile ID and fingerprint, persist that selection on the attempt, include it
in the lease/run payload, and make the Agent recheck it before starting the
process. Reject `toolchain_changed` if the fingerprint or executable no
longer matches.

Apply the exact §19.2 score formula only after hard filtering. Use `agent_id`
as the deterministic final tie-breaker and enforce the Phase 4 effective
capacity above. Persist the selected Agent and scoring inputs with the attempt
so a decision can be audited.

Use this fallback table; never silently execute locally:

- An eligible Agent with capacity: create a remote attempt.
- No eligible/capable Agent and `queue_policy=wait`: keep the job queued.
- No eligible/capable Agent and `queue_policy=fail_fast`: return the specified
  structured no-match/no-capacity failure.
- Local execution: only when `queue_policy=local_fallback`,
  `preferences.allow_local_fallback=true`, and Controller configuration allows
  it. It must use the same persisted full snapshot and retain Phase 3 safety
  restrictions; hardware/destructive classes remain ineligible unless the
  design explicitly permits them.

## Data plane and fenced tokens

Mint short-lived EdDSA JWTs using the shared credential mechanism. Bind every
token to `agent_id`, `job_id`, `attempt_id`, `lease_id`, `lease_epoch`, one
operation (`snapshot_download` or `artifact_upload`), issue/expiry times, and
the Controller audience. Never log a token. For every HTTP request, verify the
signature, expiry, operation, all tuple claims, and the Agent identity of the
authenticated session; return an authorization error before reading or writing
any file.

Implement only these data-plane operations, with paths and payload metadata
defined in the corresponding typed WS schemas:

1. `GET /data/v1/attempts/:attemptId/snapshot` for a Controller-created full
   snapshot. `prepare_source` supplies the URL, token, expected byte length,
   and SHA-256.
2. `PUT /data/v1/attempts/:attemptId/artifacts/:artifactId` for an artifact
   declared by `artifact_manifest`. The Agent sends name, type, expected size,
   and SHA-256 in the manifest before upload; the Controller verifies that the
   upload matches it before registering the artifact.

The receiver enforces configured size limits while streaming, writes to a file
in the destination filesystem, verifies byte count and SHA-256, then atomically
renames into final storage. It removes partial files on every failure. Do not
buffer an archive or artifact in memory. Reject token/tuple mismatches, size
overflow, and hash mismatch with distinct structured errors.

## Agent execution, secrets, logs, and artifacts

Create an Agent executor boundary under `apps/agent/src/executor/`. It owns an
attempt directory, full-snapshot download, `packages/snapshot` materialization,
process lifecycle, local redacted log files, artifact collection, and cleanup.
Reuse the shared Phase 3 platform adapters/executor package; do not copy
platform-specific process code into Controller or Agent glue code.

Use this full-snapshot sequence exactly:

1. Controller creates and stores the Phase 3 canonical archive and sends
   `prepare_source` with immutable metadata.
2. Agent downloads to an attempt-local `.part` file, checks size and SHA-256,
   atomically renames it, and materializes it into the attempt workspace.
3. Agent sends `source_ready` only after materialization succeeds.
4. Controller sends `run_job`; Agent revalidates the current lease and selected
   toolchain, resolves secrets, starts the shared executor, and sends
   `job_started`.
5. Agent collects artifacts, sends a manifest, uploads verified objects, then
   sends terminal exit and cleanup messages.

For the MVP secret store, configure a mapping from an allowed secret ref to an
Agent environment-variable name. Resolve it only on the Agent immediately
before spawning the process. Protected RBO environment names cannot be
overridden by job-provided environment values. Missing mappings/values fail
before the process starts with `secret_missing` and without disclosing a value.

Redact secret bytes before they reach any local log file, WebSocket frame, or
Controller log backend. The redactor must keep a bounded tail across chunk
boundaries and replace a secret split between chunks. Phase 4 has live,
ordered `log_chunk` messages with `{stream, sequence, bytes}`; the Agent uses
bounded buffering and the Controller appends received redacted chunks to the
existing Phase 3 attempt log backend. Do not implement ACKs, replay, a new
SQLite/file spool, reconnection delivery, or unbounded in-memory queues.

## Implementation order and tests

Implement and validate in this order:

1. Typed protocol schemas, token claims, and pure scheduler tests.
2. Persistent Agent session, lease registry, fencing, and capacity tests.
3. TLS data-plane routes and streaming size/hash/atomic-write tests.
4. Agent download/materialization plus shared process executor integration.
5. Redacted live logs, artifact transfer, status integration, and fallback.
6. One real Windows Controller → Windows Agent end-to-end run.

Required tests:

- scheduler hard filters, deterministic score/tie-break, selected toolchain
  profile, one-slot race, busy/offline wait/fail-fast/local-fallback policy;
- mocked macOS capability selection only (label it as scheduler coverage, not
  macOS remote-execution coverage); document if a real macOS run is unavailable;
- lease accept/reject, duplicate frame idempotence, stale epoch, wrong Agent,
  expiry, heartbeat renewal, and Agent disconnect terminal behaviour;
- expired, wrong-agent, wrong-attempt, wrong-lease, wrong-epoch, and
  wrong-operation data tokens; verify `/data/v1` cannot invoke MCP/admin APIs;
- snapshot and artifact size/hash mismatches, partial-file cleanup, and atomic
  finalization;
- full snapshot materializes identically on the Agent and never mutates the
  Controller workspace; selected toolchain change prevents process start;
- remote stdout/stderr, exit result, and artifacts are observable through the
  existing `job_wait`/`job_artifacts` APIs;
- missing secret ref is rejected; an exact secret split between two stdout
  chunks appears in neither Agent logs, WS frames, Controller logs, events,
  database, nor artifacts.

Exit criteria: a dirty `payload.mode=full` snapshot executes on a real Windows
Agent through an authenticated fenced lease; its redacted logs, terminal result,
and verified artifacts are available through the existing Controller APIs; the
Controller workspace is unchanged; `pnpm verify` is green. Record whether a
real macOS run was available, but do not claim that mocked capability coverage
is a cross-platform execution test.

Completion requirements: as in the shared rules (§0).
```

---

## Phase 5 — Repository mirror, exact overlay, local-only commits

```text
Implement only Phase 5: `payload.mode=git_overlay` execution on top of the
accepted Phase 4 remote full-snapshot path. The purpose is exact dirty-tree
reconstruction with a reusable Agent Git mirror. A full snapshot remains the
defined fallback; it must not be removed or changed.

## Start gate and non-goals

1. Read §0, §10, §11.5-§11.15, §12.1-§12.4, §19.2, §26.1, §29.4,
   §34.4-§34.5, and Phase 5 in §35.
2. Phase 4 must be accepted, including fenced remote execution, typed messages,
   data-plane hash checks, and full-mode materialization safety.
3. Resolve every Phase 3/4 snapshot-path or manifest-containment finding before
   using the same materializer for an overlay.

Do not implement log replay/recovery (Phase 6), Docker/QEMU caches (Phase 7),
or a second source-transfer protocol. Extend the typed Phase 4 lease/data-plane
contracts only where a Git overlay or bundle needs an explicit payload.

## Fixed decisions

1. Reuse `normalizeRepositoryUrl` and `computeRepoKey`; do not create another
   repository identity rule. SSH and HTTPS forms of the same repository map to
   the same `repo_key`.
2. The Controller never transfers developer Git credentials. Each eligible Agent
   uses its preconfigured read-only credential. Both Controller and Agent enforce
   the configured scheme, host, and optional repository-prefix allowlists;
   reject `file://`, local paths, external helpers, and unknown SSH hosts.
3. A mirror lives at `agent-data/repos/<repo_key>/mirror.git`; a job always gets
   its own detached worktree under `agent-data/workspaces/<attempt-id>/project`.
   Never execute in the mirror itself.
4. Only clean, initialized submodules and available LFS content are supported.
   A dirty/missing submodule fails deterministically; it is not silently copied
   or repaired. A missing required `git-lfs` capability is a scheduler mismatch.
5. Every overlay path, deletion, mode, symlink target, and additional-root mount
   uses the same safe-relative-path and collision rules as a full snapshot.

## Source protocol and Agent flow

Add typed schemas for the Phase 5 payloads and reasons. At minimum, define the
repository identity, base commit, fetch refs, overlay/bundle metadata, expected
sizes/hashes, and `source_need` reasons (`base_present`, `base_commit_missing`,
`bundle_required`, `full_snapshot_required`, `repo_fetch_failed`). Do not encode
these values in free-form message payloads.

For a git-overlay attempt, use this sequence exactly:

1. Controller captures a canonical overlay against the selected base commit:
   changed tracked files, deletions, untracked/non-ignored files, explicitly
   allowed ignored files, file modes, symlinks, empty directories, and filtered
   additional roots. Persist its deterministic manifest and content ID.
2. Controller sends `prepare_source` with repository, base commit, fetch refs,
   and overlay metadata. Agent validates the current lease and allowlist before
   every clone, fetch, bundle import, and worktree operation.
3. Under the per-repository mutex, Agent checks the mirror for the base commit,
   performs the documented targeted fetch, then reports the exact source need.
4. If the commit is local-only, Controller creates a bounded, hash-verified Git
   bundle and Agent imports it under the same mutex. Fallback order is remote
   fetch → bundle → Phase 4 full snapshot, never an unchecked checkout.
5. Agent creates a detached worktree at the exact base commit; removes declared
   deletions; applies overlay files and modes; materializes additional roots at
   their logical mounts; validates every hash and rejects unsafe symlinks.
6. Agent sends `source_ready` only after tree verification. The normal Phase 4
   `run_job`, logs, artifacts, cancellation, and cleanup then apply unchanged.

Worktree cleanup is mandatory on every terminal path: `worktree remove --force`
followed by `worktree prune`. Fetch/import is serialized per `repo_key`; checkout
and execution are not. Persist mirror `last_used_at`, active-worktree count, and
the failed acquisition reason needed for audit and scheduler decisions.

## Scheduler and cache management

After Phase 4 hard filtering, apply the §19.2 repository-cache-hit bonus only
when the selected Agent reports the same canonical repository and has the base
commit (or an allowed fetch path). It is a preference, not permission to bypass
toolchain, secret, lease, or Git allowlist checks.

Implement repo-cache maintenance as a separate Agent service. Evict only when
over the configured size, below minimum free disk, or past retention; choose LRU
by persisted `last_used_at`; never evict a mirror with an active worktree or a
held fetch/import lock. Report low disk as unavailable capacity before accepting
another job.

## Implementation order and tests

1. Overlay and repository/bundle Zod schemas plus deterministic fixture builders.
2. Agent allowlist checks, mirror metadata, per-repo lock, targeted fetch, and
   detached worktree lifecycle.
3. Overlay builder/application with byte/hash/mode/symlink verification.
4. Bundle and full-snapshot fallback integration.
5. Cache-affinity scoring, LRU eviction, and remote end-to-end tests.

Required tests:

- staged-only, unstaged-only, rename, deletion, untracked, explicit ignored,
  binary, Unicode, executable, symlink, empty-directory, and additional-root
  overlay fixtures;
- clean remote commit, local-only unpushed commit via bundle, missing commit,
  failed import, and explicit full-snapshot fallback;
- allowlist rejection on both Controller and Agent for scheme, host, prefix,
  `file://`, local path, and external helper forms;
- two concurrent attempts against one mirror create distinct worktrees and do
  not race fetch/import or cleanup; eviction skips their mirror;
- golden equality: a canonical hash of the local dirty tree equals the Agent
  materialized tree before execution, including deletions and modes;
- a repeated job proves, by recorded transferred byte counts, that it used the
  overlay/bundle path rather than sending the complete repository.

Exit criteria: an Agent reconstructs an exact dirty workspace from a cached or
fetched base commit, including a local-only HEAD through a verified bundle; the
original workspace and mirror integrity remain unchanged; `pnpm verify` is green.

Completion requirements: as in the shared rules (§0).
```

---

## Phase 6 — Long-running reliability і attempt reconciliation

```text
Implement only Phase 6: durable remote-attempt recovery, log delivery, and
reconciliation on top of accepted Phase 5 execution. This phase makes an
interrupted connection recoverable; it must not weaken lease fencing or rerun a
side-effecting script merely because a connection changed.

## Start gate and boundaries

1. Read §0, §15, §18.2, §19.4, §20.6, §21.3-§21.6, §29.4, §31, and Phase 6
   in §35.
2. Phase 5 must be accepted, including one attempt directory/worktree/log/artifact
   namespace per attempt and validated lease epochs on ordinary live messages.
3. Keep Phase 7 workloads/caches and Phase 8 packaging out of this implementation.

## Durable log protocol

Replace the Phase 4 live-only log sender with an attempt-scoped disk spool:
`agent-data/logs/<attempt-id>/{stdout.log,stderr.log,events.jsonl,ack.json}`.
The Agent appends redacted output to disk before it enters any network queue.
Assign one strictly increasing sequence to each emitted chunk/event and persist
the Controller's highest contiguous acknowledgement in `ack.json` atomically.

Controller processing is idempotent: accept a chunk only for the current fenced
tuple, durably append/store it, then send `log_ack(sequence)`. Duplicate chunks
may be acknowledged again but must not duplicate `job_logs` output. On reconnect,
the Agent sends every unacknowledged sequence in order before newer live chunks.
The network queue is bounded; when full, output continues to the disk spool and
the job process is never blocked by Controller slowness. Never silently discard
unacknowledged output: if the configured spool cap is reached, make the attempt
terminal with a distinct `log_spool_limit` failure and preserve audit metadata.

`job_logs` remains cursor-scoped to one attempt. Its cursor refers to durable
Controller bytes/chunks, never to an in-memory queue, and the response always
returns the resolved attempt ID and next cursor.

## Reconciliation state machine

Persist enough Agent-side attempt metadata to identify the current process,
workspace, lease tuple, last sent/acked sequence, artifact uploads, and cleanup
state after an Agent restart. Do not infer ownership from a directory name alone.

Use these rules exactly:

1. On Controller restart, load all non-terminal attempts, retain their current
   lease tuples and log cursors, and wait for authenticated Agent reconciliation.
   An attempt without a valid Agent confirmation by the configured deadline
   becomes `lost`; it is not automatically rerun.
2. On Agent restart, scan persisted attempt metadata and active process state.
   Report each attempt as running, completed-awaiting-upload, or orphaned; replay
   its unacknowledged logs only after Controller validates the tuple.
3. A reconnect may adopt an orphaned attempt only when Agent identity, attempt,
   lease ID, lease epoch, and persisted process identity all match the current
   Controller record. A replacement attempt or newer epoch makes the stale
   attempt ineligible: terminate/clean it and reject all of its logs/artifacts.
4. During disconnect, safe/normal jobs may continue through the documented grace
   policy. Destructive/hardware jobs must self-terminate at lease expiry without
   needing Controller contact. This is a process-control invariant, not a UI
   timeout.
5. Enforce the fenced tuple for every inbound frame, spool replay, artifact
   upload/retry, cleanup acknowledgement, and disk cleanup decision.

## Recovery and disk pressure

Create one recovery coordinator on each side; do not place recovery decisions in
ad-hoc WebSocket callbacks. Make all cleanup idempotent and safe to repeat.
Agent disk-pressure admission first stops new leases, then removes only expired
artifacts, old terminal workspaces, old terminal logs/spools, and inactive
repository caches in that order. It must never remove an active attempt, its
unacknowledged spool, or a mirror/worktree held by an active job. Publish the
resulting capacity/disk state in heartbeat/capabilities.

Artifact retry resumes only the upload of a manifest-declared, hash-verified
object for the same fenced attempt. It never re-collects from a mutable workspace
or changes the artifact metadata after Controller registration.

## Implementation order and tests

1. Typed `log_ack`, reconciliation, and recovery-report schemas plus durable
   attempt metadata migrations/tests.
2. Agent spool writer, sequence allocator, bounded sender, replay, and
   Controller idempotent append/ack handling.
3. Controller and Agent restart coordinators plus orphan/adoption state changes.
4. Lease-expiry self-termination, artifact resume, and disk-pressure admission.
5. Fault-injection integration tests before any performance test.

Required tests:

- disconnect before script start; disconnect during a safe job; reconnect replay
  with ordered, non-duplicated stdout/stderr/events; replacement attempt rejects
  every stale frame and artifact;
- real lease expiry makes a hardware/destructive job terminate without Controller;
- Controller restart during execution restores cursors and reaches either verified
  adoption or `lost`; Agent restart finds stale workspaces and applies idempotent
  cleanup after grace;
- two attempts of one job cannot mix workspace files, logs, acknowledgements,
  artifacts, or cleanup actions;
- full spool, slow Controller, and repeated reconnects maintain bounded memory
  and explicit failure rather than output loss;
- a large synthetic output test (target 1 GiB when CI resources permit, otherwise
  a gated streaming test with an explicit byte/memory assertion) proves no
  unbounded RAM accumulation.

Exit criteria: a long-running safe job survives a temporary disconnect with every
log byte available exactly once through `job_logs`; stale attempts cannot cause
side effects or publish data; destructive/hardware jobs self-stop on expired
leases; `pnpm verify` is green.

Completion requirements: as in the shared rules (§0).
```

---

## Phase 7 — QEMU, Docker і ранні build caches

```text
Implement only Phase 7: validate the existing script executor against QEMU and
Docker workflows, then add bounded Agent build caches. QEMU and Docker remain
ordinary user scripts; do not introduce a QEMU job type, Docker job type, a
container API, or a new scheduler path.

## Start gate and runtime contract

1. Read §0, §14.2-§14.4, §15.3, §16, §17, §19.2, §31.4, §32, and Phase 7 in
   §35. Phase 6 must be accepted first.
2. Verify the completion-policy implementation with its Phase 3 findings closed:
   it must have serial incremental log matching, cleared timers, bounded reads,
   and integration coverage before it is used for long-running QEMU workflows.
3. Define one canonical runtime-environment schema/documentation. It must expose
   `RBO_JOB_ID`, `RBO_ATTEMPT_ID`, `RBO_LOG_DIR`, and `RBO_ARTIFACT_DIR` to user
   scripts. Reserve these names; job-provided environment values cannot override
   them. Replace inconsistent legacy names rather than adding a silent alias.

## QEMU and Docker behaviour

For QEMU, prove that `run_for_duration` and `run_until_log_match` perform the
same lifecycle as `run_to_exit`: stream logs while the process runs, stop the
whole process tree gracefully then forcibly after grace, run cleanup, collect
artifacts, and publish a correct terminal result. The executor must not depend
on GNU `timeout`, a TTY, or a newline arriving in output.

For Docker/Compose, RBO only supplies identity and recovery hooks. Document and
test scripts that label every container, network, and volume with
`rbo.job=$RBO_JOB_ID` and `rbo.attempt=$RBO_ATTEMPT_ID`. Agent cleanup may remove
only resources carrying the exact current attempt label; it must never run a
global prune or remove a resource belonging to another attempt. Phase 6 crash
recovery invokes the same label-scoped cleanup idempotently after a verified
orphan decision.

## Build cache service

Create `apps/agent/src/build-cache/` (or an equivalently isolated Agent module),
separate from the Git mirror cache. Support named cache kinds only: `ccache`,
`sccache`, `npm`, `pnpm`, and `pip`. Each cache definition states its directory,
environment variables, quota, and whether it is readable/writable for a job.
Do not accept arbitrary host paths or arbitrary cache environment names from a
JobRequest.

Namespace each cache by at least cache kind, selected toolchain-profile ID and
fingerprint, OS/architecture, and project/repository identity. The scheduler
may award a cache-hit preference only after normal capability/secret/lease
filtering. A mismatched fingerprint is a cache miss, never a compatible cache.
Safe/normal jobs may publish only after successful completion; destructive and
hardware jobs are read-disabled or write-disabled by default, as specified by
configuration, to avoid shared-cache poisoning.

Cache writes use a per-key lock and temporary directory followed by atomic rename.
Readers see either the previous valid entry or the new verified entry, never a
partially populated cache. Apply quota/LRU only to inactive cache keys; report
hit, miss, bytes, eviction, and refusal reason as structured metrics.

## Implementation order and tests

1. Runtime environment contract and completion-policy integration tests.
2. Label-scoped Docker cleanup helpers and Phase 6 recovery hook integration.
3. Typed named-cache definitions, cache-key calculation, and safe environment
   injection.
4. Per-key locking, atomic population, quota/LRU, scheduler affinity metrics.
5. Environment-gated QEMU/Docker tests and cold-versus-warm benchmark report.

Required tests:

- a fake QEMU script proves success pattern, failure pattern, duration expiry,
  timeout, cancel, descendant kill, cleanup, and artifact collection; label it
  a fake-workload test, not a real QEMU run;
- when Docker is available, real containers, networks, and volumes tagged for an
  attempt disappear after success, failure, cancel, and Agent recovery, while a
  differently labelled resource remains untouched; otherwise register a clearly
  gated/skipped test with its prerequisite;
- a warm cache measurably avoids declared compile/install work; a changed
  toolchain fingerprint, OS/architecture, project identity, or risk policy does
  not reuse or publish the prior cache;
- concurrent population of one key has one publisher, readers never observe
  partial data, and eviction never removes an active key;
- metrics include queue wait, snapshot/transfer time, cold/warm duration, and
  cache hit/miss with the selected cache key redacted of secrets.

Exit criteria: QEMU and Docker script workflows are either verified on their real
runtime or explicitly environment-gated; build caches are isolated by compatible
toolchain/project identity and bounded by policy; the benchmark report contains
cold/warm/cache metrics; `pnpm verify` is green.

Completion requirements: as in the shared rules (§0).
```

---

## Phase 8 — Client compatibility і release hardening

```text
Implement only Phase 8: reproducible client compatibility evidence, packaging,
operations documentation, and release-hardening regressions. It is not authority
to publish a release, modify a public registry, or claim support for a client or
platform that was not actually tested.

## Start gate and release evidence

1. Read §0, §6.2, §24, §25, §26, §29-§32, §34.5, §35, and all §37 acceptance
   criteria. Phase 7 must be accepted, except explicitly documented
   environment-gated QEMU/Docker tests.
2. Freeze the supported protocol range and canonical tool schemas before writing
   client snippets. Do not create client-specific request/result schemas.
3. Treat every claimed compatibility result as an artifact: record revision,
   OS, client version, transport, configuration, executed workflow, result, and
   known limitation. “Not verified” is valid; inferred compatibility is not.

## Client compatibility matrix

For Fusion, Codex, Claude, Cursor, and Antigravity, create one machine-readable
matrix plus a human-readable report. Test the transport each client actually
supports (stdio and/or Streamable HTTP) and preserve the raw smoke-test evidence.
The workflow must submit an isolated dirty snapshot, wait, fetch incremental
logs, list/materialize an artifact where supported, and cancel a separate
long-running job. Validate that malformed input is rejected by the same shared
Zod schema over both transports.

For each verified cell, provide a minimal copy/paste configuration snippet using
`rbo mcp-stdio` or the loopback HTTP endpoint and execute that exact snippet in
the test environment. Do not embed credentials, Controller private keys, or an
absolute path specific to a developer machine in committed examples.

## Packaging and operator lifecycle

Create reproducible packaging inputs for Windows, macOS, and Linux under the
existing `packaging/` directories. The MVP deliverable may be a versioned archive
with checksums and install instructions, but it must contain the Controller,
Agent, CLI, stdio adapter, Windows helper where applicable, default config
templates, and a version manifest. Packaging must not include Controller identity
keys, Agent credentials, caches, logs, snapshots, or test data.

Add a scripted install/verify/uninstall workflow for each OS. Verify service
registration/status/start/stop where the platform supports it; if a platform is
not available, make its test explicitly gated rather than simulating success.
The operator runbook must give exact, recoverable procedures for install, pair,
approve, drain, revoke, repair, update, backup, restore, and uninstall.

Define backup/restore boundaries: back up the SQLite database, Controller data
needed for attempts/artifacts/logs, and identity material only through an
operator-protected mechanism. Restore must validate ownership, file hashes, and
schema migrations before starting the Controller. Credential recovery/revocation
must never instruct an operator to copy Agent private keys between machines.

## Compatibility, observability, and security gates

Test upgrades and downgrades across every version in the declared wire min/max
range. An incompatible peer remains diagnostic-only and receives no lease or data
token. Preserve migration forward/backward behaviour supported by the project;
fail explicitly when a downgrade is unsupported rather than corrupting state.

Publish a structured observability report containing queue wait, snapshot capture,
transfer, execution, cold/warm build, cache hit rate, local-fallback rate, Agent
selection, lease/epoch, toolchain fingerprint, and terminal outcome. IDs are
correlation fields; secret values, tokens, raw credentials, and unredacted logs
are never observability fields.

Build one threat-focused regression suite from §34.5. It must include traversal
in manifests/archive paths, relative and absolute symlink escape, tar bomb and
oversized file, duplicate normalized/case-colliding paths, Windows reserved names,
artifact destination junction/symlink swap, hash mismatch, expired/wrong token,
forged Agent ID, stale lease replay, certificate fingerprint mismatch, secret
policy, Git allowlist, and cross-client idempotency. Reuse prior tests where they
prove the exact case; add a regression test for every historical finding.

## Implementation order and acceptance

1. Freeze protocol/schema compatibility fixtures and build the common smoke-test
   harness used by stdio and HTTP.
2. Produce client matrix evidence and validated configuration snippets.
3. Add deterministic packaging manifests/checksums and OS install lifecycle tests.
4. Add backup/restore and upgrade/downgrade tests, then operator runbook.
5. Complete observability report and the threat-regression suite; audit all 23
   §37 criteria one by one with a link to its test or explicit environment gate.

Exit criteria: a new worker machine can be installed, paired, verified, revoked,
and removed using only the runbook; every claimed AI-client cell has recorded
smoke evidence; package contents exclude secrets; all required security and
compatibility tests pass or are explicitly environment-gated; `pnpm verify` is
green. Completion requires a signed-off §37 acceptance checklist, not a demo.

Completion requirements: as in the shared rules (§0).
```
