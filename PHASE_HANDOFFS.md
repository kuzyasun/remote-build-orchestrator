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

Scope (тільки те, що design явно кладе в Phase 3 — full snapshot payload
mode, ЛОКАЛЬНЕ isolated виконання; git_overlay/mirror і remote Agent
execution — це Phase 4/5, НЕ роби їх):

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
     resume, стрімити stdout/stderr назад у stdout helper-a (Node парсить),
     graceful cancel → terminate Job Object. Напиши Rust integration test:
     child спавнить grandchild, після cancel обидва процеси відсутні
     (§15.2 явно вимагає цей тест). Якщо збірка/тест реального Windows
     Job Object неможливі в поточному sandboxed-середовищі виконання —
     задокументуй ЯК ТОЧНО ти це перевірив (напр. локально поза sandbox)
     і залиш чіткий TODO, не вигадуй фейковий "passing" тест, який нічого
     не перевіряє;
   - cleanup_script виконується після success/failure/timeout/cancel/
     execution error (§15.3).
5. Local append-only logs (§21.3 підмножина — без network spool/ack, це
   Phase 6): stdout.log/stderr.log/events.jsonl у workspace/logs.
6. Artifact collection (§22.1-§22.3 підмножина без remote upload):
   glob-based scan, max file count/size configurable з дефолтами, SHA-256
   кожного файла, директорії архівуються, symlink artifacts заборонені.
7. `job_submit` MCP tool (§23.2) — ДОДАЙ до
   packages/protocol/src/mcp-tools.ts (JOB_SUBMIT_INPUT = JobRequestSchema
   forma, реюзни existing z object). Controller-side:
   - ідемпотентність через jobs/submissions.ts (вже є reserveSubmission/
     completeSubmission) — НЕ переписуй цю логіку, інтегруй з нею;
   - safe/normal → одразу queued → capture snapshot → materialize →
     execute (синхронно "локально" немає remote scheduler'а, це Phase 3
     виконує локально в Controller process, тому "queued"→"matching"→
     "leased" переходи для local executor можуть бути миттєвими/тривіальними,
     головне що стан у БД записаний коректно й послідовно за §18.1);
   - destructive/hardware → created → awaiting_confirmation, повертає
     confirmation_token (короткоживучий, прив'язаний до request hash +
     snapshot content_id + risk_level — можеш підписати EdDSA JWT через
     вже наявний packages/shared crypto, або HMAC з окремим локальним
     секретом — обери простіше, задокументуй рішення);
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

---

## Phase 4 — Remote full-snapshot execution

```text
Implement only Phase 4 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §9 (increasingly §9.1-§9.6), §12.2-§12.4, §18, §19, §20, §21
   (без disk-spool replay — то Phase 6, лише "incremental live log chunks"),
   §29 (§29.2 короткоживучі fenced job tokens), §30, §34.2 (частина: mirror
   init/fetch — Phase 5, ігноруй ці пункти в Phase 4, лише non-repo-cache
   тести), §35 Phase 4.
2. Переконайся, що Phase 3 прийнята (є job_submit/job_confirm, isolated
   local execution, snapshot capture, artifact/log backends реальні).
3. Не читай Phase 5/6/7/8.

Ключове: Phase 3 виконує jobs ЛОКАЛЬНО в Controller process (isolated
workspace на тій самій машині). Phase 4 додає СПРАВЖНІЙ remote Agent
execution — той самий job тепер може піти на agt_* через
apps/agent/src/connection/client.ts (наразі лише pairing/auth, без jobs!).

Deliverables:
1. Capability hard filtering і scheduler score (§19.1-§19.3) — реалізуй у
   apps/controller/src/scheduler/ (нова директорія): match required
   os/arch/tools/labels/secret_refs/min_memory/min_disk проти
   agents.capabilities_json (уже зберігається через
   agents/registry.ts:updateAgentCapabilities); score формула з §19.2.
2. Execution attempts, lease offer/accept, epoch fencing, lease renewal
   (§19.4): нові WS-повідомлення lease_offer/lease_accept/lease_reject
   (типи вже є в packages/protocol/src/messages.ts
   ControllerMessageTypeSchema/AgentMessageTypeSchema — використай їх, не
   вигадуй нові). Кожен job_attempts запис отримує lease_id/lease_epoch
   (колонки вже є в migration v1 job_attempts table — реюзни).
3. Attempt-scoped data tokens (§29.2) — короткоживучі EdDSA JWT (той
   самий механізм, що device credential в packages/shared/src/crypto.ts)
   зі scope agent_id+job_id+attempt_id+lease_id+operation.
4. Authenticated snapshot download/artifact upload через /data/v1
   (§7.1 — цей endpoint MUST бути на порту 7411, TLS, і НЕ повинен
   надавати MCP/admin operations; зараз 7411 обслуговує лише WS
   /agent — додай HTTP data routes на той самий https.Server instance,
   що вже створює apps/controller/src/websocket/server.ts, або підніми
   окремий https listener на тому ж порту з path-based routing).
5. Download/upload size+hash verification, temp file + atomic rename,
   cleanup partial downloads, download limits (§12.3).
6. Remote source materialization на Agent: apps/agent/src/executor/ (нова
   директорія) — той самий isolated materialize код з Phase 3
   (packages/snapshot), викликаний тепер на Agent-стороні після
   run_job/prepare_source команд від Controller.
7. Remote process execution через ТІ САМІ platform adapters, що
   локальний executor Controller'а в Phase 3 (§0.1 rule 10 — не
   дублюй платформо-специфічний код поза adapter boundary; якщо Phase 3
   реалізував executor у apps/controller/src/execution/, винеси спільну
   частину в окремий package, напр. packages/executor, і імпортуй з обох
   apps/controller і apps/agent).
8. Agent-side secret injection зі stateful pre-spool redaction (§29.5,
   §29.6) — named secret store на Agent (config-driven, env-var-backed
   мінімум для MVP), redactor, що працює через межі log chunks.
9. Incremental live log chunks (§21.1-21.2) без накопичення в RAM —
   Controller→Agent вже має log_chunk у AgentMessageTypeSchema, зроби
   реальний streaming шлях WS→Controller SQLite/файл-спул (без
   ack/replay — то Phase 6).
10. Terminal result + artifacts повертаються тим самим job_wait/
    job_artifacts API, що Phase 3 зробив для local jobs — переконайся,
    що вони працюють однаково для remote attempt.
11. Isolated local fallback ЛИШЕ за request/config policy (§19.5) —
    preferences.allow_local_fallback / queue_policy=local_fallback вже є
    в JobRequestSchema, реалізуй фактичну fallback-логіку в scheduler'і.
12. Один активний job на Agent у MVP (max_jobs enforcement).

Required tests (§35 Phase 4):
- Windows Controller → macOS Agent (якщо немає macOS машини в CI — mock
  agent capabilities з os.family=macos і задокументуй, що реальний macOS
  прогон не виконувався тут);
- Windows Controller → Windows Agent (це можна реально прогнати в цьому
  середовищі — пріоритизуй);
- short-lived/expired/wrong-attempt data token;
- replayed lease epoch (старий epoch не повинен прийматися);
- snapshot hash mismatch;
- Agent без required toolchain profile не match-иться;
- Agent без requested secret ref не match-иться; exact secret, розділений
  між stdout chunks, не потрапляє у spool/Controller (тестуй, що
  redactor ловить secret навіть якщо він розбитий по межі двох chunks);
- remote busy/offline policy: wait, fail-fast, isolated local fallback.

Exit criteria: dirty full snapshot виконується на Windows Agent (і
задокументовано, якщо не на Mac), logs та artifacts повертаються,
локальний workspace на Controller-машині не змінюється.

Completion requirements: як у спільних правилах (розділ 0).
```

---

## Phase 5 — Repository mirror, exact overlay, local-only commits

```text
Implement only Phase 5 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §10 (весь розділ), §11.5, §11.9-§11.15, §12.1 (git_overlay
   гілка — вже є в SnapshotManifestSchema, використай її, не редагуй),
   §26.1 (git allowlist config), §29.4 (repo access policy), §34.5
   (Git remote scheme/host rejection), §35 Phase 5.
2. Переконайся, що Phase 4 прийнята (remote execution реально працює
   для payload.mode=full).

Deliverables:
1. Canonical repository identity (§10.2) — вже є
   packages/shared/src/paths.ts: normalizeRepositoryUrl/computeRepoKey.
   Reuse, не переписуй; якщо потрібні edge-cases (GitHub SSH з портом,
   тощо) — вже покриті тестами в protocol.test.ts, звір перед зміною.
2. Git host/scheme allowlist (§10.4, §26.1) — конфігурована allowlist на
   Controller (allowed_schemes/allowed_hosts/allowed_repository_prefixes);
   Agent MUST перевіряти allowlist ПОВТОРНО перед clone/fetch (не довіряй
   лише Controller-side перевірці).
3. Per-repo bare mirror + fetch mutex на Agent (§10.3, §10.9) —
   apps/agent/src/repo-cache/ (нова директорія): `git clone --mirror`,
   targeted fetch (§10.6), mutex за repo_key, кешується під
   agent-data/repos/<repo_key>/mirror.git.
4. Detached attempt worktree (§10.8) — create/remove/prune за
   documented git commands.
5. Commit acquisition fallback order (§10.5, §10.7): remote fetch → Git
   bundle → full snapshot fallback. Controller-side bundle creation коли
   Agent повідомляє base_commit_missing.
6. Exact overlay/deletion list/modes/additional roots для git_overlay
   payload mode (§11.5, §11.9-§11.13) — ти вже маєш
   GitOverlaySnapshotManifestSchema в packages/snapshot; напиши
   packages/snapshot/src/overlay-builder.ts, що генерує цей маніфест
   (аналогічно до capture.ts з Phase 3, але base = Git commit, а не
   повний working tree).
7. Deterministic overlay manifest + targeted fetch протокол (§12.2) —
   lease_offer→prepare_source→source_need→(fetch|bundle)→source_ready
   sequence вже описана в design; wire message types вже існують у
   packages/protocol/src/messages.ts.
8. Submodules policy (§11.14), Git LFS policy (§11.15) — clean-only
   підтримка, dirty → fail, dirty submodule можна додати як additional
   root (документована policy, не auto-workaround).
9. Repo LRU eviction (§10.10) без видалення repo з active worktrees
   (§10.9 — cleanup MUST не чіпати active repos).
10. Scheduler cache-affinity score (§19.2 repository_cache_hit бонус) —
    доповнення до Phase 4 scheduler-а.

Required tests (§35 Phase 5):
- staged, unstaged, rename, delete, untracked, binary, Unicode fixtures
  для overlay (аналог Phase 3 snapshot тестів, але git_overlay mode);
- clean remote commit, local-only commit, missing commit;
- unauthorized Git scheme/host rejection (і на Controller, і повторно
  на Agent);
- concurrent worktrees одного mirror (два jobs, одна repo, різні
  worktrees, без конфлікту);
- golden local/remote tree hash equality (§34.4 — фікстур-репозиторій,
  хеш локального дерева == хеш дерева, матеріалізованого на Agent);
- повторний job передає лише overlay/bundle, а не весь repository
  (перевір фактичний обсяг переданих байтів, не просто "працює").

Exit criteria: remote Agent відтворює exact dirty workspace на cached
base, включно з local-only HEAD.

Completion requirements: як у спільних правилах (розділ 0).
```

---

## Phase 6 — Long-running reliability і attempt reconciliation

```text
Implement only Phase 6 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §15.1-§15.2 (containment вже готовий з Phase 3/4 — тут лише
   reliability навколо нього), §18.2 (стейт-машина orphaned/adoption вже
   описана — переконайся, що реалізація точно їй відповідає), §19.4
   (lease renewal — базове вже з Phase 4, тут edge cases), §20.6, §21.3-
   §21.6 (disk spool + sequence/ack + backpressure — це головне НОВЕ тут,
   Phase 4 зробив лише "живий" стрім без persistence/replay), §31 (весь
   розділ — Controller/Agent restart recovery), §35 Phase 6.
2. Переконайся, що Phase 5 прийнята.

Deliverables:
1. Attempt-scoped disk log spool (§21.3) з sequence/ack (§21.4), replay
   після reconnect, bounded network queue з backpressure (§21.5) — це
   заміна "живого лише" стріму з Phase 4 на persistent+resumable.
2. Controller restart recovery (§31.1): читає non-terminal jobs при
   старті, чекає reconnect Agents, reconcile active jobs, відновлює log
   cursors, job без Agent confirmation → lost.
3. Agent restart/stale workspace recovery (§31.2): сканує stale
   workspaces, визначає orphaned jobs, cleanup після grace period,
   повідомляє Controller про crash recovery.
4. Disconnect grace, orphaned state, adoption rules (§18.2, §20.6) —
   реалізуй ПОВНУ стейт-машину переходів orphaned→running (adopt) і
   orphaned→cleaning (stale reconnect) точно як у mermaid-діаграмі §18.2.
5. Safe/normal orphan timeout vs destructive/hardware self-termination
   після lease expiry БЕЗ Controller (§19.4, §29.4) — це критичний
   security-інваріант, не пропускай.
6. Stale epoch fencing — застарілий lease_epoch НЕ може materialize-ити
   artifacts як результат новішого attempt (Phase 4 заклав epoch у
   job_attempts, тут — enforce на кожному вхідному повідомленні від
   Agent, не лише на прийомі lease).
7. Artifact retry/resume, disk-pressure admission control (§31.4) — Agent
   перестає приймати нові jobs, видаляє expired artifacts/old workspaces/
   logs, repo LRU eviction у порядку з design.
8. 1 GB log handling без unbounded RAM — перевір реальним тестом з
   великим синтетичним виводом, не лише "малим" фікстуром.

Required tests (§35 Phase 6):
- disconnect до script start;
- disconnect під час safe build і успішне adoption;
- replacement attempt уже стартував → stale attempt зупиняється;
- hardware job самозупиняється без Controller (реальний lease expiry,
  не мокований таймер);
- Controller restart під час execution;
- Agent restart із stale workspace;
- дві attempts одного job не змішують logs/artifacts/workspaces;
- 1 GB stdout і Controller backpressure (не має ані впасти, ані
  накопичити весь вивід в RAM — перевір memory-обмежений тест, напр.
  через process.memoryUsage() sanity-check або streaming-архітектуру
  code review, залежно що практичніше протестувати автоматично).

Exit criteria: long-running job переживає тимчасовий disconnect без
втрати logs; duplicate side effects та attempt data collision неможливі
за protocol tests.

Completion requirements: як у спільних правилах (розділ 0).
```

---

## Phase 7 — QEMU, Docker і ранні build caches

```text
Implement only Phase 7 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §16 (QEMU workflow examples — це приклади user-scripts, не
   нова абстракція, §0.1 rule ADR-007: script лишається головною execution
   abstraction), §17 (Docker workflow, resource ownership/labels), §35
   Phase 7.
2. Переконайся, що Phase 6 прийнята.

Важливо: design явно каже (§16, §17, ADR-007) що QEMU/Docker НЕ отримують
спеціальний job type у MVP — вони працюють як звичайний user script
всередині вже готового execution/completion механізму (run_for_duration,
run_until_log_match — Phase 3 вже реалізував ці completion types).
Тому Phase 7 — це переважно (а) verification, що існуючий script executor
коректно підтримує ці конкретні воркflow-паттерни (background process +
log tailing + cleanup trap), і (б) build cache layer, яка є новою.

Deliverables:
1. Перевір і, якщо потрібно, доопрацюй completion policy run_for_duration
   та run_until_log_match (вже в CompletionPolicySchema з Phase 0, backend
   виконання — Phase 3) для QEMU-подібних сценаріїв: graceful stop після
   duration, force kill після grace, збір artifacts після duration/
   pattern match.
2. Docker/Compose resource labels (rbo.job/rbo.attempt) — переконайся, що
   RBO_JOB_ID/RBO_ATTEMPT_ID env vars (мають бути з Phase 3
   ExecutionConfigSchema env injection) доступні user script для
   label-ування контейнерів.
3. Deterministic cleanup після Agent process crash/restart (§17.1-§17.2 +
   інтеграція з Phase 6 crash recovery) — orphaned Docker resources теж
   мають прибиратись при Agent restart recovery, не лише workspace files.
4. Named cache definitions для ccache/sccache/npm/pnpm/pip
   (apps/agent/src/repo-cache/ вже існує з Phase 5 для Git repos — додай
   паралельну структуру для build caches, окремий package/директорія,
   напр. apps/agent/src/build-cache/).
5. Cache keys включають toolchain profile fingerprint + architecture +
   project (fingerprint вже є в ToolchainProfileSchema з Phase 0 —
   toolchain_profiles Agent capabilities поки завжди [], тому це Phase 7
   MAY зробити мінімальну toolchain profile activation, якщо Phase 4/5 її
   ще не реалізували — задокументуй залежність, якщо блокує).
6. Quotas/LRU для build cache + metrics cache hit/miss.
7. Cache poisoning guard: destructive/hardware jobs НЕ публікують shared
   cache за замовчуванням (RiskLevelSchema вже має ці рівні з Phase 0).

Required tests (§35 Phase 7):
- QEMU success/failure pattern, timeout, cancel (можна з фейковим
  "qemu"-скриптом-заглушкою, якщо реального QEMU немає в середовищі —
  задокументуй це явно, не приховуй);
- Docker containers/networks/volumes відсутні після success/failure/
  cancel (потрібен реальний Docker daemon в тестовому середовищі; якщо
  недоступний — задокументуй як skipped/gated test з чіткою умовою
  запуску, не підробляй результат);
- warm cache скорочує compile work і НЕ використовується з іншим
  toolchain fingerprint;
- cache eviction не зачіпає active job.

Exit criteria: QEMU та Docker integration scenarios стабільні (або чесно
задокументовані як environment-gated), benchmark report показує queue/
snapshot/transfer/cold-build/warm-build durations.

Completion requirements: як у спільних правилах (розділ 0). Явно
позначай будь-який тест, що вимагає QEMU/Docker/hardware, недоступного в
sandbox — це очікувано і прийнятно, головне не видавати заглушку за
реальний прогін.
```

---

## Phase 8 — Client compatibility і release hardening

```text
Implement only Phase 8 from remote-build-orchestrator-design.md.

Before editing:
1. Read §0, §24 (весь розділ — AI client integration contract і
   compatibility matrix), §34.5 (повний security regression suite), §35
   Phase 8.
2. Переконайся, що Phase 7 прийнята (або прийнята з задокументованими
   environment-gated обмеженнями).

Deliverables:
1. Заповнити §24.1 compatibility matrix РЕАЛЬНИМИ результатами smoke
   tests для Fusion/Codex/Claude/Cursor/Antigravity — для кожного:
   транспорт (stdio/HTTP), workflow (submit→wait→logs/artifacts/cancel).
   Якщо якийсь клієнт недоступний для реального прогону в цьому
   середовищі — задокументуй explicit "not verified here", НЕ позначай
   як підтримуваний.
2. Configuration snippets для кожного клієнта (як підключити
   `rbo mcp-stdio` або Streamable HTTP endpoint) — короткі, реально
   перевірені приклади, не гіпотетичні.
3. Installer packages для трьох OS (packaging/windows, packaging/macos,
   packaging/linux — директорії вже існують як .gitkeep placeholders,
   §6.2). Мінімум: build script, що пакує controller+agent+cli в
   дистрибутив (навіть якщо це просто zip з бінарниками + install
   instructions для MVP, а не MSI/pkg/deb).
4. Upgrade/downgrade compatibility test у межах підтримуваного protocol
   range (RBO_WIRE_PROTOCOL_MIN/MAX_VERSION з packages/shared/src/
   versions.ts — зараз обидва =1; якщо Phase 4-7 підняли max version,
   тест повинен це покривати).
5. Retention, backup/restore Controller state (SQLite db + data dir) і
   credential recovery guide (документація +, якщо практично, CLI-команда
   для backup/restore).
6. Operator runbook: install, pair, drain, revoke, repair, update,
   uninstall — на основі вже існуючих CLI команд (controller init/
   fingerprint, agent approve/revoke/install/uninstall).
7. Performance/observability report із §32 метриками — структуровані
   логи (§32.1) вже частково є через packages/shared/src/logging.ts;
   переконайся, що ключові events (agent_selected, snapshot_captured,
   тощо) логуються з тими самими полями, що в §32.1 приклад.
8. Threat-focused regression suite §34.5 — повний список: ../, absolute
   archive path, symlink escape, tar bomb, duplicate normalized path,
   Windows reserved name, oversized file, expired token, forged Agent ID,
   replayed lease, hash mismatch, secret blocked, Controller certificate
   fingerprint mismatch, artifact destination junction/symlink swap, Git
   remote scheme/host rejection, cross-client idempotency namespace.
   Багато з цих тестів вже мали з'явитись у Phase 2-6 (fingerprint
   mismatch, forged agent, replayed lease, cross-client idempotency —
   перевір, чи вони вже існують, і лише ДОПОВНИ відсутні, не дублюй).

Required tests: див. §34.5 повністю (список вище) — це і є required
tests для цієї фази, разом із §24.1 smoke workflows.

Exit criteria (§35): новий worker PC можна встановити, pair-ити,
перевірити й видалити за документацією; кожен заявлений AI client
проходить submit/wait/logs/cancel/artifact smoke workflow (або чесно
позначений як not verified).

Після завершення Phase 8 — звір систему проти §37 Acceptance criteria
(повний список із 23 пунктів) і §40 підсумкової моделі; це фінальний
acceptance gate усього MVP, не лише Phase 8.

Completion requirements: як у спільних правилах (розділ 0).
```
