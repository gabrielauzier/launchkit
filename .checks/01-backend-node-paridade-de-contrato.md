# Backend Node.js (Fastify) com paridade de contrato

profile: light · handoff: on · budget 150k por batch

Sources:

- `.tasks/01-backend-node-paridade-de-contrato.md` - **a fonte**: 42 critérios em 7 slices, `Decided`, `Unresolved`. Os números `C1..C42` abaixo são os números dos critérios.
- `docs/prds/prd-feature-1-node-fastify-backend.md` - histórias 1 a 5 e 7, FR-001 a FR-008 e FR-010
- `docs/plans/feature-1-node-fastify-backend.md` - fases, decisões D3 a D7
- `backend/app/` e `backend/tests/` - o contrato de referência; `backend/uv.lock` fixa fastapi 0.142.2, fastapi-users 15.0.5, pwdlib 0.3.0
- Sem interface binding: a task não tem tela (profile `light`).

## Out of scope

- Remover ou congelar o backend Python - as duas stacks seguem mantidas.
- Mudar o contrato da API - mudança de contrato começa no Python e é replicada no Node.
- Rodar as duas stacks sobre o mesmo banco **em produção** - risco de corrupção; a suíte de contrato roda as duas ao mesmo tempo sobre o mesmo Postgres só nos casos cruzados (C9, C11, C18, C21), sem DDL concorrente.
- Enviar e-mail de reset de senha - o Python também não envia; o Node espelha.
- Tipos de `frontend/src/types` a partir do OpenAPI, provider S3, renomear `backend/`, escolha da stack em Compose/Helm/`install.sh`/release (task 2).
- Cobertura de rotas sem critério dono (ver `## Handoff`, "Lacunas da task"): `GET /api/info`, `GET /api/timezones`, `GET /api/settings/files`, `GET /api/auth/oidc/config`, `GET|PATCH|DELETE /api/users/{id}` (só o 422 do `PATCH` entra, via C16), `GET/PATCH/DELETE` de `files` além de upload/download. A task é a fonte; não as acrescento aos 42.

## Proof environment

Todo proof de contrato roda a partir de `contracts/`, com um arquivo `contracts/.env.local` (fora do git) que aponta para PostgreSQL e Redis de teste (containers `t01-pg`, `t01-redis`):

```
cd contracts && CONTRACT_STACK=<python|node> npx vitest run <arquivo> -t "<Cn ...>"
```

O título de cada caso começa com o id do check (`C6 ...`). Sem `API_URL`, o `globalSetup` do vitest sobe as duas stacks (a assunto e a par, em portas livres, sobre o mesmo Postgres/Redis, com `TRUSTED_PROXY_HOPS=1`, `SECRET_KEY` sintético, stdout/stderr do Node em `contracts/.logs/node.log`); com `API_URL`, usa o servidor dado (e `PEER_API_URL` para os casos cruzados). Casos que dependem de configuração (C7, C8, C11, C13, C22, C42) sobem uma instância própria da stack assunto com o `env` do caso (`spawnStack`). `contracts/scripts/summary.mjs` lê o relatório JSON do vitest e falha se `failed != 0` (e, com `--no-skip`, se `skipped`/`todo != 0`).

Checks cujo proof só pode rodar no CI do GitHub (job novo no workflow) dizem isso no próprio check, com o proof local equivalente.

## Landing

Toca `backend/scripts/` (script novo), `backend/tests/` (um teste novo), `.github/ci/` e `ci.yml` (aditivo), `contracts/` (pacote novo) e `backend-node/` (pacote novo). Reusa: `backend/alembic/versions/001_initial_schema.py` (DDL a reproduzir), `backend/tests/*` (casos a portar), `frontend/src/lib/api-errors.ts` (consumo de `detail`).

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| Exportador do contrato | `python backend/scripts/export_openapi.py [--output PATH] [--check]`: grava `contracts/openapi.json` com `json.dumps(spec, indent=2, sort_keys=True) + "\n"`, fixando `APP_NAME=launchkit` antes do import; `--check` não grava, sai com 1 e imprime o diff se o arquivo difere | gravar a saída crua de `app.openapi()`: muda com `backend/.env` (`APP_NAME`) e com a ordem das rotas, e o job `contract-drift` falharia por ruído |
| Forma da suíte de contrato | pacote `contracts/` (Vitest + `fetch`, sem dependência de `backend-node/`); entrada `API_URL`, `PEER_API_URL`, `CONTRACT_STACK`, `CONTRACT_DATABASE_URL`, `CONTRACT_REDIS_URL`; fixtures criam usuários só por `POST /api/auth/register` e `POST /api/setup/create-admin`, e semeiam hashes/linhas direto no Postgres; zero `skip`/`skipIf`/`todo` | `app.inject()` do Fastify e `httpx.ASGITransport`: não cruzam o processo, não rodam contra a outra stack; fixtures por `/api/admin/users`: acoplariam o início da suíte à slice de admin |
| Migration inicial do Drizzle | `backend-node/drizzle/0000_initial.sql` escrita à mão (`drizzle-kit generate --custom`), mesmo DDL, mesma ordem de colunas e mesmos nomes de constraint/índice que a `001` do Alembic; schema TS declara a mesma forma | SQL gerado por `drizzle-kit generate`: nomes de FK (`*_fk`) e ordem de colunas diferem, o `pg_dump` não fica idêntico |
| Baseline sobre banco do Alembic | `applyMigrations(db)`: se existe `alembic_version` com `version_num = '001'` e `drizzle.__drizzle_migrations` vazia, insere a linha `{hash, created_at}` da migration `0000` (calculada por `readMigrationFiles`) sem DDL; em seguida chama o `migrate()` do Drizzle | `drizzle-kit push` ou ignorar o migrator: sem registro, o Node tentaria recriar tabelas no banco do Python |
| Driver de Postgres do Node | `pg` (node-postgres) em produção; `@electric-sql/pglite` em `npm test`; o tipo do banco é `PgDatabase<any>` do Drizzle, nunca o tipo de um driver | `postgres` (porsager): sem ganho e a task 4 já assume `pg`+PGlite |
| Porta `KeyValueStore` | `get(key)`, `set(key, value, {ttlSeconds?})`, `getdel(key)`, `del(key)`, `rateLimitHit(key, nowSeconds, windowSeconds): Promise<number>` (devolve a contagem **antes** de registrar a chamada, atômico); `RedisStore` (MULTI/EXEC) e `MemoryStore` | expor `zadd/zcard/zremrangebyscore`: vaza o Redis para as rotas e perde a atomicidade que `pipeline()` do redis-py dá |
| Porta `JobQueue` | `enqueue(name, payload)`, `register(name, handler)`, `schedule(name, everySeconds)`, `start()`, `close()`; `BullMqQueue` e `InProcessQueue` | BullMQ direto: exige Redis |
| Porta `StorageProvider` | mesma interface de `backend/app/providers/storage.py`: `name`, `upload(key, data, contentType) -> {storageKey,size,contentType}`, `download(key)`, `delete(key)`, `getUrl(key)` | - (forçado: Decided) |
| Falha do Redis nas rotas com limite | a porta propaga o erro de conexão (`maxRetriesPerRequest: 1`, `enableOfflineQueue: false`) e o error handler global devolve 500 `Internal Server Error` em `text/plain` (o corpo do Starlette, que o Python devolve; não JSON); nada é engolido | engolir o erro e liberar a requisição: contradiz C42 e o Python |
| Configuração do Node | `loadConfig(env = process.env): Config` em `backend-node/src/config.ts`: Zod sobre as mesmas variáveis do `Settings` do Python, campos em camelCase (`localAuthEnabled`, `secretKey`, `trustedProxyHops`, ...); ordem de precedência igual à do pydantic-settings (variável de ambiente, depois `.env`, depois `CREDENTIALS_DIRECTORY`/`/run/secrets`, depois padrão); a validação de C8 roda dentro de `loadConfig`, e `server.ts`, `worker.ts` e `cli.ts` chamam só ele | ler `process.env` espalhado pelos módulos: C8 teria que valer em cada ponto |
| Montagem da aplicação | `buildApp(ctx: AppContext): FastifyInstance` onde `AppContext = {config, db, keyValueStore, jobQueue, storage}`; `server.ts` e o harness de `npm test` montam o contexto e chamam a mesma função | um `app.ts` por entrada: a configuração de partida passaria a existir em duas montagens |
| Erros e validação | um `setErrorHandler` global: `HttpError(status, detail, headers?)` vira `{"detail": detail}`; `ZodError` de `body|querystring|params|headers` vira 422 `{"detail":[{"type","loc":[<body|query|path|header>, ...caminho],"msg","input"}]}`; corpo JSON malformado vira 422 `json_invalid`; 404 de rota `{"detail":"Not Found"}`; 405 `{"detail":"Method Not Allowed"}` | o formato nativo do Fastify: o frontend lê `detail` (já Decided); aqui fica só o mapeamento |
| Ordem das guardas | cada rota declara suas guardas em `preValidation`, na ordem das dependências do FastAPI: política (`LOCAL_AUTH_ENABLED`, registro) -> rate limit -> autenticação -> validação do corpo; assim 403, 429 e 401 vêm antes de 422, como no Python | `preHandler`: a validação do Fastify roda antes e devolveria 422 onde o Python devolve 401/403/429 |
| Pacote `backend-node` | ESM (`"type":"module"`), Node >= 22, `tsx` em desenvolvimento e `tsc` para `dist/`, scripts `dev`, `build`, `start`, `test`, `lint`, `typecheck`, `cli`; adiciona às dependências Decided: `pg`, `@fastify/formbody` (login em `x-www-form-urlencoded`), `@fastify/cors`, e em desenvolvimento `@electric-sql/pglite`, `tsx`, `typescript`, `eslint`, `typescript-eslint` | CommonJS: `jose`, `@simplewebauthn/server` e `openid-client` são ESM-first |
| Banco do Alembic em outra revisão | se `alembic_version` existe com `version_num` diferente de `001`, `applyMigrations` lança `Error("alembic revision <x> is not known to this build; expected 001")` e o processo não sobe | rodar as migrations do Drizzle assim mesmo: tentaria `CREATE TABLE` sobre tabelas existentes, falha obscura ou, pior, um schema pela metade |
| `pg_dump` no diff de schema | `schema-diff.sh` remove as linhas `\restrict` e `\unrestrict` (token aleatório do pg_dump >= 16.10) e usa `--no-owner --no-privileges`; o `pg_dump` é o do próprio servidor (`PG_DUMP_CMD`, aqui `docker exec t01-pg pg_dump`, no CI o cliente 16 do runner) | comparar o dump cru: o token muda a cada execução e o diff nunca é vazio |

- Nada mais nesta mudança é difícil de reverter. Portas descobertas durante o build entram aqui **antes** do código que as fecha.

## Checks

### S1 - Contrato congelado · 9 files · 47 KB · ~12k (+ libs ~4k) = ~16k

**C1** - `python backend/scripts/export_openapi.py` grava `contracts/openapi.json` com as 61 operações HTTP do Python (52 em `backend/app/api/`, 8 do fastapi-users, 1 `GET /api/health`)
Proof: `.venv/bin/python -m pytest backend/tests/test_export_openapi.py::test_exported_file_lists_all_61_operations`
Proof: `.venv/bin/python -m pytest backend/tests/test_export_openapi.py::test_operations_split_52_8_1` (agrupa `app.routes` por módulo do endpoint: `app.api.*` = 52, `fastapi_users.*` = 8, `app.main` = 1)

**C2** - Se `contracts/openapi.json` difere da exportação atual, o job `contract-drift` do CI falha
Proof (local): `.venv/bin/python -m pytest backend/tests/test_export_openapi.py::test_check_mode_exits_1_when_the_file_drifts` (arquivo adulterado em `tmp_path` via `--output`; exit code 1)
Proof (local): `python3 .github/ci/test_workflow_jobs.py ContractDriftJobTest.test_job_runs_the_export_check` (o bloco `contract-drift:` de `ci.yml` contém o passo `python backend/scripts/export_openapi.py --check`)
CI-only: a falha do job em si só aparece no GitHub; os dois proofs locais cobrem o comando e a presença do passo.

**C3** - Dado o Python sobre PostgreSQL, `contracts/tests` com `API_URL` apontando para ele: 0 casos falham
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run --reporter=json --outputFile=.logs/python.json && node scripts/summary.mjs .logs/python.json`
Proof: `contracts/tests/health.test.ts` caso `C3 GET /api/health returns 200 {"status":"healthy"}` (o primeiro caso da suíte; as slices seguintes acrescentam os seus)
Gate: rodado de novo em todo batch com a suíte do momento.

**C4** - Dado o Node sobre PostgreSQL, a mesma suíte no mesmo commit: 0 casos falham e 0 pulados por stack
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run --reporter=json --outputFile=.logs/node.json && node scripts/summary.mjs .logs/node.json --no-skip`
Proof: `contracts/tests/meta.test.ts` caso `C4 no case is skipped or conditioned on the stack` (varre `tests/**/*.test.ts`: nenhum `.skip`, `.skipIf`, `.todo`, `.only`, nenhum `if (stack ===` fora de `tests/support/`)
CI-only: o job `contract` (matriz `python|node`) roda os dois comandos; local: os mesmos comandos.
Gate: rodado em todo batch.

### S2 - Entrar e cadastrar · 18 files · 66 KB · ~17k (+ libs ~22k + Node landed ~6k) = ~45k

**C5** - `users` vazio: `GET /api/setup/status` 200 `{"has_users": false}`; `POST /api/setup/create-admin` com `email` e `password` 200 `{"access_token","token_type":"bearer"}`; segunda chamada 403 `{"detail":"Setup already completed"}`
Proof: `contracts/tests/00-setup.test.ts` `C5 setup status, create-admin and the second create-admin`

**C6** - `POST /api/auth/login` (`application/x-www-form-urlencoded`, `username`, `password`) válido: 200 `{"access_token","token_type":"bearer"}`; senha errada: 400 `{"detail":"LOGIN_BAD_CREDENTIALS"}`
Proof: `contracts/tests/login.test.ts` `C6 valid login returns a bearer token`, `C6 wrong password returns 400 LOGIN_BAD_CREDENTIALS`

**C7** - `LOCAL_AUTH_ENABLED=false` com OIDC completo: `POST /api/auth/login`, `POST /api/setup/create-admin` e troca de senha em `PATCH /api/users/me` respondem 403 `{"detail":"LOCAL_AUTH_DISABLED"}`
Proof: `contracts/tests/local-auth-disabled.test.ts` `C7 login is 403 LOCAL_AUTH_DISABLED`, `C7 create-admin is 403 LOCAL_AUTH_DISABLED`, `C7 password change on PATCH /api/users/me is 403 LOCAL_AUTH_DISABLED` (instância `spawnStack` com OIDC completo apontando para o provedor falso)

**C8** - `LOCAL_AUTH_ENABLED=false` sem OIDC completo: o processo encerra com código ≠ 0 e a mensagem `LOCAL_AUTH_ENABLED=false requires a complete OIDC configuration; missing: <lista>`
Proof: `contracts/tests/startup-config.test.ts` `C8 server exits non-zero and names what is missing` (tabela de 7 combinações, ver Coverage)
Proof: `backend-node/test/config.test.ts` `C8 loadConfig throws the same message for all 7 combinations`

**C9** - Usuário criado por uma stack com hash argon2 (e outro com hash bcrypt) entra na outra stack com a mesma senha: 200 com token válido, nos dois sentidos e nos dois formatos
Proof: `contracts/tests/cross-stack-hash.test.ts` `C9 argon2 user created on python logs in on node`, `C9 argon2 user created on node logs in on python`, `C9 bcrypt user logs in on python`, `C9 bcrypt user logs in on node` (bcrypt: linha semeada no Postgres, entra nas duas)

**C10** - Usuário com hash bcrypt: após login bem-sucedido no Node, o hash armazenado começa com `$argon2`
Proof: `contracts/tests/login.test.ts` `C10 a bcrypt hash is replaced by an argon2 hash after a successful login`, rodado com `CONTRACT_STACK=node` **e** com `CONTRACT_STACK=python` (Unresolved 1: se o Python não troca o hash, PARE e relate, não mude o critério)

**C11** - Token emitido por uma stack com o mesmo `SECRET_KEY`: `GET /api/users/me` 200 na outra, nos dois sentidos; token expirado: 401
Proof: `contracts/tests/cross-stack-token.test.ts` `C11 token from python is accepted by node`, `C11 token from node is accepted by python`, `C11 token issued with ACCESS_TOKEN_EXPIRE_MINUTES=-1 is rejected with 401`, `C11 token claims are sub=<uuid>, aud=["fastapi-users:auth"], alg HS256`

**C12** - O 6º `POST /api/auth/login` do mesmo IP em 60 s: 429 `{"detail":"Too many requests"}` com `Retry-After: 60`; o 4º `POST /api/auth/register` do mesmo IP em 3600 s: 429 com `Retry-After: 3600`
Proof: `contracts/tests/rate-limit.test.ts` `C12 sixth login in 60 s is 429 with Retry-After 60`, `C12 fourth register in 3600 s is 429 with Retry-After 3600`

**C13** - `TRUSTED_PROXY_HOPS=1` e `X-Forwarded-For: a, b`: a chave do rate limit usa `b`; com `TRUSTED_PROXY_HOPS=2` e um único valor: `unknown`
Proof: `contracts/tests/rate-limit.test.ts` `C13 hops=1 keys on the last X-Forwarded-For entry`, `C13 hops=2 with a single entry keys on unknown` (lê a chave `rate_limit:/api/auth/login:<ip>` no Redis)
Proof: `backend-node/test/rate-limit.test.ts` `C13 resolveClientIp over the 7 cases of backend/tests/test_rate_limit.py`

**C14** - `POST /api/auth/register` com registro desligado: 403 `{"detail":"Registration is currently disabled"}`; ligado: 201 e `GET /api/workspaces` do novo usuário lista 1 workspace pessoal
Proof: `contracts/tests/register.test.ts` `C14 registration disabled is 403`, `C14 registration enabled is 201 and lists one personal workspace` (desligar por `app_settings.registration_enabled='false'` no Postgres)

**C15** - `POST /api/auth/forgot-password` com um e-mail: 202 e nenhum e-mail ou token emitido; `POST /api/auth/reset-password` com token inválido: 400 `{"detail":"RESET_PASSWORD_BAD_TOKEN"}`
Proof: `contracts/tests/password-reset.test.ts` `C15 forgot-password is 202 and writes nothing to Redis`, `C15 reset-password with a bad token is 400 RESET_PASSWORD_BAD_TOKEN`

**C16** - Qualquer rota que recebe corpo inválido: 422 `{"detail":[{"loc":["body",...],"msg","type"}]}`
Proof: `contracts/tests/validation.test.ts` `C16 invalid body is 422 in FastAPI shape` (tabela das 25 operações com corpo; ver Coverage)
A suíte cresce com as slices: a tabela de `validation.test.ts` ganha as operações da slice no batch que a constrói. Batch 1: as 7 de S2 (`forgot-password`, `login`, `register`, `reset-password`, `setup/create-admin`, `users/me`, `users/{id}`), nas duas stacks. Fecha por inteiro quando as 18 restantes chegam (S3 no batch 2, S4 no batch 2, S5 no batch 3).

### S3 - 2FA, passkeys e OIDC · 10 files · 113 KB · ~28k (+ libs ~28k + Node landed ~12k) = ~68k

**C17** - 2FA ativo, login válido: 200 `{"requires_2fa":true,"temp_token","available_methods":["totp"]}`; `"passkey"` só entra com 2FA ativo e ao menos 1 passkey
Proof: `contracts/tests/two-factor.test.ts` `C17 2fa on, no passkey -> ["totp"]`, `C17 2fa on, one passkey -> ["totp","passkey"]`, `C17 2fa off, one passkey -> plain token`, `C17 2fa off, no passkey -> plain token`

**C18** - O login que emite `temp_token` grava `2fa_temp:<temp_token>` no Redis com JSON `{"user_id","available_methods"}` e TTL de 300 s; um `temp_token` de uma stack é aceito por `POST /api/auth/2fa/verify` da outra; usado uma vez, é recusado na segunda com 401 `{"detail":"Invalid or expired token"}`
Proof: `contracts/tests/two-factor.test.ts` `C18 temp token is stored as 2fa_temp:<token> with JSON and TTL 300`, `C18 temp token from python verifies on node`, `C18 temp token from node verifies on python`, `C18 a temp token used once is 401 Invalid or expired token`

**C19** - `POST /api/auth/2fa/verify` com código errado: 400 `{"detail":"Invalid 2FA code"}`; o 6º pedido do mesmo IP em 60 s: 429
Proof: `contracts/tests/two-factor.test.ts` `C19 wrong code is 400 Invalid 2FA code`, `C19 sixth verify in 60 s is 429`

**C20** - `POST /api/auth/2fa/disable` com senha errada: 400 `{"detail":"Invalid password"}`; sem 2FA configurado: 400 `{"detail":"2FA is not set up"}`
Proof: `contracts/tests/two-factor.test.ts` `C20 disable with a wrong password is 400 Invalid password`, `C20 disable without 2FA set up is 400 2FA is not set up`

**C21** - Passkey registrada por uma stack autentica na outra (nos dois sentidos); os challenges ficam no Redis como `<prefixo>:<challenge_id>` no mesmo formato nas duas stacks
Proof: `contracts/tests/passkeys-cross.test.ts` `C21 passkey registered on python authenticates on node`, `C21 passkey registered on node authenticates on python`, `C21 challenges are stored as passkey_register|passkey_authenticate|passkey_2fa:<id> with the same JSON keys on both stacks`

**C22** - `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGIN` vazios: RP ID e origin vêm da origem do request; `WEBAUTHN_RP_ID` fixo e origem fora dele: mesmo status e `detail.code` do Python
Proof: `contracts/tests/webauthn-origin.test.ts` `C22 rp id and origin follow the request origin`, `C22 origin outside the pinned rp id is 400 passkey_origin_mismatch` (+ as 10 linhas do Coverage)

**C23** - `GET /api/auth/oidc/login` com OIDC configurado: 307 para o `authorization_endpoint` com `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`; o Redis guarda `oidc_state:<state>` com JSON `{"nonce","code_verifier"}`
Proof: `contracts/tests/oidc.test.ts` `C23 login redirects with the eight parameters`, `C23 state is stored as oidc_state:<state> with nonce and code_verifier`

**C24** - `GET /api/auth/oidc/callback` com `code` e `state` válidos: 307 para `<FRONTEND_URL>/auth/oidc/callback#access_token=<jwt>&token_type=bearer`
Proof: `contracts/tests/oidc.test.ts` `C24 callback redirects to the frontend with an app token in the fragment`

**C25** - A suíte contém um caso para cada caso de `test_oidc_auth.py` (18), `test_passkeys.py` (27) e `test_two_factor.py` (14, um parametrizado em 2), e todos passam nas duas stacks
Proof: `contracts/tests/meta.test.ts` `C25 every python case of test_oidc_auth, test_passkeys and test_two_factor has a contract case` (compara `contracts/parity-map.json` com as funções `test_*` dos três arquivos e com os títulos da suíte)
Proof: `CONTRACT_STACK=python` e `CONTRACT_STACK=node`, arquivos `oidc-*.test.ts`, `passkeys-*.test.ts`, `two-factor*.test.ts`, 0 falhas

### S4 - Workspaces · 12 files · 82 KB · ~20k (+ libs ~3k + Node landed ~15k) = ~38k

**C26** - `X-Workspace-Id` não UUID: 400 `{"detail":"Invalid X-Workspace-Id"}`; workspace inexistente, arquivado ou do qual o usuário não é membro nem gerente: 404 `{"detail":"Workspace not found"}`; cabeçalho ausente: vale o workspace padrão, e sem nenhum, 404 `{"detail":"No workspace available"}`
Proof: `contracts/tests/workspace-context.test.ts` seis casos `C26 ...` (ver Coverage), todos via `GET /api/workspaces/current`

**C27** - Viewer escreve: 403 `{"detail":"Read-only role"}`; editor chama rota exclusiva de owner: 403 `{"detail":"Owner role required"}`; gerente (`managed_by_user_id`) tem direitos de owner sem linha em `workspace_members`
Proof: `contracts/tests/workspace-roles.test.ts` `C27 viewer write is 403 Read-only role`, `C27 editor on an owner-only route is 403 Owner role required`, `C27 manager without a membership row acts as owner`
**CONFLITO com o Python (achado no EXTRACT):** nenhuma rota usa `ctx.require_owner()`; as rotas exclusivas de owner (`PATCH /api/workspaces/{id}`, `POST|PATCH members`, `POST archive`) respondem 403 `{"detail":"Insufficient role"}` (`workspace_service.require_membership`). O segundo caso não passa contra o Python (C3). Bloqueado até o usuário decidir; não será ajustado em silêncio.

**C28** - Cada uma das 12 operações de `/api/workspaces` e `/api/users` (`lookup`, `directory`) tem ao menos 1 caso com status e corpo, incluindo `archive` e a remoção de membro
Proof: `contracts/tests/workspaces.test.ts` `C28 <METHOD> <path>` por operação (12 linhas no Coverage)

**C29** - Dois `POST /api/workspaces/{id}/members` simultâneos para o mesmo usuário: `workspace_members` fica com 1 linha para o par (`uq_workspace_member`) e a segunda resposta é igual à da duplicata sequencial do Python
Proof: `contracts/tests/workspaces.test.ts` `C29 two concurrent invites leave one membership row`, `C29 the loser answers like the sequential duplicate (409 User is already a member)`
Risco: o Python não captura `IntegrityError` nessa corrida; se ele devolver 500 na concorrência, a segunda resposta "igual à da duplicata sequencial" (409) não vale para o Python. Resultado do Python decide: PARE e relate.

**C30** - A suíte contém os casos de `test_write_permission_gate.py` para viewer, editor e owner, todos passando nas duas stacks
Proof: `contracts/tests/write-gate.test.ts` `C30 a viewer cannot upload`, `C30 a viewer cannot change a file (PATCH, DELETE)`, `C30 a viewer can still read`, `C30 the gate is about role not identity`, `C30 an editor can upload`

### S5 - Admin e arquivos · 12 files · 67 KB · ~17k (+ libs ~4k + Node landed ~20k) = ~41k

**C31** - Usuário sem `is_superuser` em qualquer rota de `/api/admin/*`: 403; sem token: 401
Proof: `contracts/tests/admin-access.test.ts` `C31 non-superuser is 403 and anonymous is 401 on every /api/admin operation`
**CONFLITO com o Python (achado no EXTRACT):** 4 das 13 operações não exigem superuser: `GET /api/admin/registration-status` e `GET /api/admin/default-colors` são públicas (200 sem token), `GET /api/admin/number-format` e `GET /api/admin/date-format` aceitam qualquer usuário ativo (200). O claim "qualquer rota" é falso contra o Python (C3). O proof cobrirá as 9 operações com `current_superuser` até o usuário decidir; as 4 divergentes ficam registradas e não serão ajustadas em silêncio.

**C32** - Cada uma das 13 operações de `/api/admin/*` tem ao menos 1 caso com status e corpo
Proof: `contracts/tests/admin.test.ts` `C32 <METHOD> <path>` por operação (13 linhas no Coverage)

**C33** - `POST /api/files` acima de `STORAGE_MAX_FILE_SIZE_MB`: 400 `{"detail":"File too large. Maximum size is <N> MB."}`; extensão fora de `STORAGE_ALLOWED_EXTENSIONS`: 400 `{"detail":"File type '.<ext>' is not allowed. Allowed: <lista>"}`; válido: 201 com o registro
Proof: `contracts/tests/files.test.ts` `C33 oversize upload is 400 File too large`, `C33 disallowed extension is 400 File type not allowed`, `C33 valid upload is 201 with the file record`

**C34** - `GET /api/files/{id}/download`: 200 com `Content-Type` do registro e `Content-Disposition: inline; filename*=UTF-8''<nome codificado>`; id inexistente ou de outro workspace: 404 `{"detail":"File not found"}`
Proof: `contracts/tests/files.test.ts` `C34 download returns the stored type and an RFC 5987 disposition`, `C34 unknown id is 404 File not found`, `C34 an id from another workspace is 404 File not found`

### S6 - Jobs e CLI · 3 files · 4 KB · ~1k (+ libs ~10k + Node landed ~5k) = ~16k

**C35** - Worker Node e Redis: o job `ping` retorna `"pong"`; o scheduler registra `report-user-count-hourly` a cada 3600 s e, a cada execução, loga `There are <N> users`
Proof: `backend-node/test/worker.test.ts` `C35 ping returns pong` (BullMQ sobre o Redis de teste)
Proof: `backend-node/test/worker.test.ts` `C35 the scheduler registers report-user-count-hourly every 3600 s`, `C35 each run logs There are <N> users`

**C36** - `npm run cli -- create-user <email> <senha>` cria o usuário, o workspace pessoal e imprime `User created successfully: <email>`; `create-admin`: `Admin created successfully: <email>` e `is_superuser` verdadeiro; argumentos fora de `create-user|create-admin <email> <senha>`: uso e código 1
Proof: `backend-node/test/cli.test.ts` `C36 create-user prints the success line and creates the personal workspace`, `C36 create-admin sets is_superuser`, `C36 bad arguments print usage and exit 1`

### S7 - Banco, portas, falhas de dependência, segredos e CI · 13 files · 40 KB · ~10k (+ libs ~10k + Node landed ~5k) = ~25k

**C37** - Dois bancos vazios, Alembic em um e Drizzle no outro: `pg_dump --schema-only` idêntico (ignorando `alembic_version` e `__drizzle_migrations`); uma diferença faz o job `schema-diff` falhar
Proof: `backend-node/scripts/schema-diff.sh` (exit 0 com os dois bancos)
Proof: `backend-node/scripts/schema-diff.sh --self-test` (adiciona uma coluna ao banco do Drizzle e exige exit 1)
CI-only: o job `schema-diff` roda o script no GitHub; local: o mesmo script contra os containers `t01-pg`.

**C38** - Banco criado pelo Alembic com `alembic_version` = `001`: o Node sobe sem DDL e registra a migration inicial como aplicada; banco vazio: cria as 6 tabelas
Proof: `backend-node/test/db/baseline.test.ts` `C38 an alembic 001 database gets no DDL and the initial migration is recorded`, `C38 an empty database gets the 6 tables`

**C39** - `npm test` em `backend-node/` sem `REDIS_URL`: testes de integração passam com `KeyValueStore` e `JobQueue` em memória
Proof: `cd backend-node && env -u REDIS_URL npm test`
Proof: `backend-node/test/ports/memory.test.ts` `C39 MemoryStore and InProcessQueue satisfy the port contracts`

**C40** - Sempre, nenhuma linha de log do Node durante a suíte de contrato contém a senha, o `access_token`, o `temp_token` ou o `SECRET_KEY` usados nos casos
Proof: `contracts/tests/99-logs.test.ts` `C40 node.log contains none of the passwords, access tokens, temp tokens or SECRET_KEY used by the suite` (registro `tests/support/secrets.ts`, último arquivo da execução)
Gate: rodado em todo batch, sobre o log da execução.

**C41** - PR só em `backend-node/`: `.github/ci/changes.py` marca `run_backend_node=true` e `run_backend`, `run_frontend`, `run_helm` `false`; PR em `contracts/`: `run_backend_node` e `run_backend` `true`; caminho desconhecido continua rodando tudo; `test_changes.py` cobre os três casos
Proof: `python3 .github/ci/test_changes.py CIChangesTest.test_backend_node_only` , `CIChangesTest.test_contracts_select_both_backends`, `CIChangesTest.test_unknown_path_still_runs_everything`
CI-only: o consumo de `run_backend_node` pelos jobs novos só roda no GitHub; local: `test_workflow_jobs.py ChangesWiringTest.test_new_jobs_read_run_backend_node`.

**C42** - Redis fora: `POST /api/auth/login` e as demais rotas com rate limit respondem 500, como o Python
Proof: `contracts/tests/redis-down.test.ts` `C42 <METHOD> <path> is 500 when redis is down` por operação (10 linhas no Coverage), nas duas stacks (instância `spawnStack` com `REDIS_URL=redis://127.0.0.1:1`)

## Swept

- validation: C16 (422), C33 (arquivo), C19/C20 (códigos), C26 (`X-Workspace-Id`)
- failure modes: C8 (processo não sobe), C16, C42
- idempotency and retry: C5 (segundo `create-admin` 403), C18 (`temp_token` de uso único)
- authorization: C26, C27, C31 (com o conflito registrado), C7 (política de login local)
- concurrency and ordering: C29 (convites simultâneos), C12 (janela deslizante; ordem das dependências login/rate-limit igual ao Python)
- data lifecycle: C28 (arquivar, remover membro), C34 (download após exclusão não existe: `delete` é de S5, caso `C28`/`files.test.ts` `C34`), C18/C23 (TTL de 300 s e 600 s)
- external-dependency failure: C42 (Redis), C23/C24 (provedor OIDC falso derrubado: mesmo status do Python, caso em `oidc-failures.test.ts`)
- state transitions: C17 (matriz de métodos), C28 (arquivado), C10 (bcrypt → argon2)
- observability: C40 (log padrão do Fastify/pino, sem métricas, sem segredos)

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| operações do Python (61) | C1, `test_exported_file_lists_all_61_operations` compara a lista inteira | - |
| origens das operações (3) | `app.api` 52 · `fastapi_users` 8 · `app.main` 1, C1 `test_operations_split_52_8_1` | - |
| operações com corpo (25) | S2 (7): `forgot-password` `login` `register` `reset-password` `setup/create-admin` `users/me` `users/{id}`, todas em C16 `validation.test.ts` | S3 (9: `2fa/disable` `2fa/enable` `2fa/verify` `passkeys/2fa/options` `passkeys/2fa/verify` `passkeys/authenticate/options` `passkeys/authenticate/verify` `passkeys/register/options` `passkeys/register/verify`), S4 (4: `workspaces` `workspaces/{id}` `workspaces/{id}/members` `workspaces/{id}/members/{uid}`), S5 (5: `admin/settings/{key}` `admin/users` `admin/users/{id}` `files` `files/{file_id}`): 18, ficam para os batches das suas slices |
| senha por stack e formato de hash (4) | argon2 py→node C9 · argon2 node→py C9 · bcrypt@python C9 · bcrypt@node C9 | - |
| combinações incompletas de OIDC com `LOCAL_AUTH_ENABLED=false` (7) | nenhum campo, só enabled, só client_id, só discovery, enabled+client_id, enabled+discovery, client_id+discovery: tabela única em C8 (`missing:` lista os que faltam, nessa ordem `OIDC_ENABLED=true, OIDC_CLIENT_ID, OIDC_DISCOVERY_URL`) | - |
| entradas de `resolve_client_ip` (7) | par sem proxy C13 · sem par → `unknown` C13 · 1 salto C13 · prefixo forjado ignorado C13 · 2 saltos C13 · cadeia curta → `unknown` C13 · cabeçalho ausente → `unknown` C13 | - |
| operações com rate limit (10) | `login` C42 · `logout` C42 · `register` C42 · `forgot-password` C42 · `reset-password` C42 · `2fa/verify` C42 · `passkeys/authenticate/options` C42 · `passkeys/authenticate/verify` C42 · `passkeys/2fa/options` C42 · `passkeys/2fa/verify` C42 | até o batch 3: as 5 de S3 chegam no batch 2, C42 fecha no batch 3 |
| estados de `available_methods` (4) | 2fa+0 passkey C17 · 2fa+1 passkey C17 · sem 2fa+1 passkey C17 · sem 2fa+0 C17 | - |
| formatos de chave no Redis (5) | `2fa_temp` C18 · `oidc_state` C23 · `passkey_register` C21 · `passkey_authenticate` C21 · `passkey_2fa` C21 | - |
| resultados da resolução de origem WebAuthn (10) | derivado do request C22 · `http://localhost` permitido C22 · IP rejeitado `passkey_origin_ip` C22 · loopback IP rejeitado C22 · http inseguro `passkey_origin_insecure` C22 · rp fixo em subdomínio C22 · fora do rp fixo `passkey_origin_mismatch` C22 · `X-Forwarded-Host` C22 · origem inválida `passkey_origin_invalid` C22 · origem ausente `passkey_origin_missing` C22 | - |
| resultados de `X-Workspace-Id` (6) | não UUID C26 · inexistente C26 · arquivado C26 · não membro nem gerente C26 · ausente com padrão C26 · ausente sem nenhum C26 | - |
| casos de teste do Python a portar (59) | `test_oidc_auth.py` 18 · `test_passkeys.py` 27 · `test_two_factor.py` 14, todos em `parity-map.json`, C25 | - |
| operações de workspaces e usuários (12) | `GET workspaces` · `POST workspaces` · `GET workspaces/current` · `PATCH workspaces/{id}` · `GET .../members` · `POST .../members` · `PATCH .../members/{uid}` · `DELETE .../members/{uid}` · `GET .../stats` · `POST .../archive` · `GET users/lookup` · `GET users/directory`, todas em C28 | - |
| operações de `/api/admin/*` (13) | `GET users` · `POST users` · `GET users/{id}` · `PATCH users/{id}` · `DELETE users/{id}` · `GET settings/{key}` · `PATCH settings/{key}` · `DELETE settings/{key}` · `GET timezone` · `GET registration-status` · `GET default-colors` · `GET number-format` · `GET date-format`, todas em C32 | - |
| montagens de configuração na partida (3) | `server.ts` C8 · `worker.ts` C35 · `cli.ts` C36, as três chamam o mesmo `loadConfig()` e o mesmo `buildContext()`; a rota HTTP usa `buildApp(ctx)`, que `server.ts` e o harness de `npm test` compartilham | - |

- Checks cujo claim cita status, rota ou corpo de resposta: C5, C6, C7, C12, C14, C15, C16, C17, C18, C19, C20, C23, C24, C26, C27, C28, C29, C31, C32, C33, C34, C42 - cada um tem proof de contrato HTTP que cruza a fronteira (processo real, `fetch`)
- Nenhum outro check afirma mais que o caso único que o proof exercita

## Handoff

Método de estimativa: `wc -c / 4` sobre os arquivos que a slice lê (ver cada título) é o piso; somo a ele (a) leitura estimada de bibliotecas que a slice exige (fastapi-users e pwdlib, py_webauthn, SimpleWebAuthn, openid-client, otpauth, BullMQ, Drizzle, `@fastify/multipart`) e (b) o código Node que slices anteriores deixaram e a slice relê. Só o piso de arquivos soma 105k e caberia num batch; o corte abaixo usa o piso mais (a)+(b) porque é o que o agente de fato lê.

| Slice | Piso (arquivos) | + libs | + Node já pronto | Estimativa | Acumulado |
| --- | --- | --- | --- | --- | --- |
| S1 | 12k | 4k | 0 | 16k | 16k |
| S2 | 17k | 22k | 6k | 45k | 61k |
| S7 (fundações: schema, migrations, baseline, portas) | 10k | 10k | 5k | 25k | - |
| S3 | 28k | 28k | 12k | 68k | - |
| S4 | 20k | 3k | 15k | 38k | - |
| S5 | 17k | 4k | 20k | 41k | - |
| S6 | 1k | 10k | 5k | 16k | - |

- **Batch 1 = S1 + S2** (61k). As fundações de S7 (esquema Drizzle, migration `0000`, baseline, `KeyValueStore`) são pré-requisito de S2 (o Node não responde sem banco) e ~15k delas entram aqui: 76k. S3 entraria a 144k, sem folga para o que a aritmética não alcança, e é onde a superfície muda (passkeys, OIDC e 2FA leem outros arquivos do Python e outras bibliotecas): corte em S2.
- **Batch 2 = S3 + S4** (68k + 38k = 106k). S5 entraria a 147k, sem folga; S4 → S5 também troca de superfície (workspaces → admin/arquivos).
- **Batch 3 = S5 + S6 + S7** (41k + 16k + ~10k que restam de S7 = ~67k). S7 fecha por último porque C40 e C42 são propriedades da suíte inteira e das 10 rotas com limite, e C39 precisa do `InProcessQueue` de S6. Os proofs de S7 que não dependem de rota (C37, C38, C41) rodam já no batch 1, em verde antecipado, sem fechar a slice.
- **Checks que atravessam batches (gate, rodados em todo batch com a suíte do momento):** C3, C4, C40. **Fecham depois da slice dona:** C16 (batches 2-3), C42 (batch 3).
- **Lacunas da task (a decidir pelo usuário, não alterei critério algum):** C27 (segundo caso) e C31 (4 das 13 operações) contradizem o Python; C29 depende do comportamento do Python na corrida; 8 rotas sem critério dono listadas em `Out of scope`.

### Batch 1 fechado (S1 + S2)

- **Onde o limite caiu:** S1 (C1-C4) e S2 (C5-C15, e as 7 operações de S2 de C16) estão verdes no commit `dc221e3`. Em verde antecipado, sem fechar S7: C37 (`schema-diff.sh --self-test`), C38 (`baseline.test.ts`), C41 (`test_changes.py`, 3 casos) e C40 sobre a suíte de contrato deste batch. Continuam abertos: C16 (as outras 18 operações), C39, C42 e tudo de S3-S6. O corte seguinte é S3 + S4 (batch 2), depois S5 + S6 + S7 (batch 3). Cada batch roda de novo o gate C3, C4, C40 sobre a suíte do momento.
- **O que o usuário já decidiu:** Zod para validação; Redis fora = 500 como o Python; log padrão do Fastify (pino) sem métricas. Unresolved 1 respondido pelo caso C10 contra o Python: o Python troca o hash bcrypt por argon2 no login (`$argon2id$v=19$m=65536,t=3,p=4`), então o critério 10 vale como escrito. Ainda aguardam o usuário: o conflito de C27 (`Insufficient role` no Python), o de C31 (4 das 13 rotas de admin não exigem superuser) e o risco de C29 (corrida de convites no Python).
- **O que foi abandonado:** (1) SQL da migration gerado por `drizzle-kit generate`: nomes de FK e ordem de colunas diferem do Alembic; a `0000_initial.sql` é à mão e o snapshot de `drizzle/meta` vem do `schema.ts`. (2) `pg_dump` do host (14.18) contra o servidor 16: recusa por versão; o `schema-diff.sh` recebe `PG_DUMP_CMD` e aqui roda `docker exec ... pg_dump`. (3) E-mails `@contract.test` nas fixtures: o email-validator do pydantic rejeita domínios de uso especial; as fixtures usam `@example.com`. (4) Node 24 LTS do plano: o ambiente tem Node 22 e o CI do frontend usa 22; `engines >=22` em `backend-node` e `contracts`. (5) `@fastify/multipart` instalado e sem uso até S5. (6) Diferenças conhecidas e sem critério: `created_at` sai com milissegundos (`.142Z`) e o Python com microssegundos; método errado numa rota existente dá 404 no Node e 405 no Python.
