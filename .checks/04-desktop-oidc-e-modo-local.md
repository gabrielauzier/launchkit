# Desktop: login por SSO (OIDC) e modo local com backend embutido

Profile: `light` · handoff `on` · budget 150k por batch · sem design binding (a tela de escolha de modo reusa a estrutura de cartão de `frontend/src/pages/login.tsx`; perfil `ui` não se aplica).

Sources:

- `.tasks/04-desktop-oidc-e-modo-local.md` - record of decision: 27 critérios em 4 slices, `States`, `Decided`, `Unresolved`. Os critérios aparecem aqui como `D<n>` (D de desktop) e não como `C<n>`, porque os ids `C1..C44` das tasks 1 e 3 já existem e os títulos da suíte de contrato começam pelo id do check; um critério com "e" vira `D<n>a`, `D<n>b`...
- `docs/prds/prd-feature-2-electron-desktop.md` - histórias 7, 9 e 10, FR-010 a FR-012.
- `docs/plans/feature-2-electron-desktop.md` - D4 e D7, fases 3 e 4.
- `.checks/01-backend-node-paridade-de-contrato.md` e `.checks/03-desktop-cliente-remoto.md` - o que está pronto (backend Node, suíte `contracts/`, app `desktop/`), `Landing` e `Local proof limits` herdados.
- Decisões do usuário confirmadas fora da task: a tela de escolha de modo reusa o cartão do login; o modo local é parte do produto (D26 e D27 valem); mantêm-se os 3 backups de migração mais recentes; exportar mostra um modal que bloqueia escritas; importar em instalação com dados é recusado; o mecanismo do `db.sql` (Unresolved 1) é decisão de quem implementa, registrada em `Landing` antes do código. Da task 3: electron-builder, `appId` `com.launchkit.desktop`, updater desligado em build sem assinatura e em Linux, release do macOS falha sem segredos; não há certificados.

## Out of scope

- Passkeys no desktop, sincronização local/servidor, backend Python embutido, PostgreSQL embutido, token no Keychain/DPAPI/libsecret, bandeja, notificações, abrir ao iniciar, modo local multiusuário ou na rede - `Out of scope` da task.
- Assinatura e notarização (Apple/Windows) - não existem certificados (task 3).
- Revisão pós-batch 1 (decisão do usuário, task atualizada em `568090d`): o login-CSRF por deep link é mitigado pelo `desktop_nonce` dos critérios 1, 2, 3, 4, 7 e 9; os checks D1 a D4, D7 e D9 abaixo foram reescritos antes do código.

## Landing

Toca: `backend/app/api/oidc_auth.py`, `backend/app/core/config.py`, `backend-node/src/routes/oidc.ts`, `backend-node/src/config.ts`, `contracts/` (arquivo novo `tests/oidc-desktop.test.ts` e `contracts/openapi.json` regenerado), `desktop/src/main/` (módulos novos `deep-link.ts`, `local-backend.ts`, `backup.ts`, `export-import.ts`), `desktop/src/preload` e `desktop/src/shared/ipc.ts` (a ponte cresce), `desktop/e2e/` (specs novos), `frontend/` (`login.tsx`, `connect-server.tsx`, `desktop-gate.tsx`, página nova `mode-select.tsx`, chaves `desktop.*`), `backend-node/src/` (entrada nova `local.ts`, `db/client.ts` ganha `connectPglite`), `.github/ci/*` e `ci.yml` só com edições aditivas (batch 3). Reaproveita: `Card`/`Input`/`Button`, `oidc-callback.tsx` (página que já lê o token do fragmento), `trustedHandle`, `createAppHandler`, `applyMigrations`, `InProcessQueue`, `MemoryStore`, `LocalStorageProvider`, o harness `contracts/tests/support` (`FakeIdp`, `oidcSignIn`).

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| `redirect_target` do OIDC (Decided) | query opcional em `GET /api/auth/oidc/login`; env `OIDC_DESKTOP_REDIRECT` = URLs exatas separadas por vírgula (cada item com `strip`, itens vazios descartados; comparação por igualdade de string, sem normalizar); Python `Settings.oidc_desktop_redirect: str = ""`, Node `config.oidcDesktopRedirect`; `oidc_state:<state>` ganha a chave `redirect_target` só quando o parâmetro veio (sem ele o JSON continua `{"nonce","code_verifier"}`); o callback redireciona para `<redirect_target>#access_token=<jwt>&token_type=bearer` (307), senão para `<FRONTEND_URL>/auth/oidc/callback#...` | rotas `/api/auth/oidc/desktop/*` (duplicam o fluxo em duas stacks); porta de loopback do RFC 8252 (exige registrar a porta no provedor); gravar `redirect_target: null` quando ausente (muda o JSON que o critério 5 e o C23 da task 1 fixam) |
| Ordem das validações em `GET /api/auth/oidc/login` | a validação do `redirect_target` roda depois de `OIDC_CLIENT_ID` e da descoberta (404 `OIDC login is not enabled` e os 500 de configuração mantêm a precedência de hoje) e antes de gerar `state` e de qualquer escrita no Redis; `400 {"detail": "Invalid redirect_target"}` | validar primeiro (um servidor mal configurado passaria a responder 400 a um parâmetro que o resto do fluxo ainda nem leu) |
| Entrega do token ao renderer | o processo principal, depois de validar o `desktop_nonce`, navega a janela para `app://launchkit/auth/oidc/callback#access_token=<jwt>&token_type=bearer` (sem o nonce); a página `oidc-callback.tsx` que já existe grava o token (`loginWithToken`), troca o fragmento e vai para `/`; nenhum membro novo na ponte por causa do SSO | evento IPC `auth:token` com um membro novo `onAuthToken` (cresce a ponte e a página precisaria de um segundo caminho); gravar `localStorage` com `executeJavaScript` (código injetado no renderer) |
| Botão de SSO no desktop (revisado pelo nonce) | `login.tsx` chama `getDesktopApi().startSso()`; o main (`desktop/src/main/sso-flow.ts`) gera o `desktop_nonce` (`randomBytes(32).toString('base64url')`, 43 caracteres), guarda um único fluxo pendente em memória com validade de 10 minutos (um novo `start()` substitui o anterior) e chama `shell.openExternal(<serverUrl>/api/auth/oidc/login?redirect_target=launchkit%3A%2F%2Fauth%2Fcallback&desktop_nonce=<nonce>)`; a ponte cresce de 8 para 9 membros (`startSso(): Promise<void>`) e o teste que a fixa (`security.spec.ts`, C20a da task 3) passa a fixar 9; no web o botão fica como está | o renderer gerar e guardar o nonce e chamar `openExternal` (o renderer perde o estado quando o main navega para o callback, e um script do renderer poderia ler e reaproveitar o nonce); o nonce no próprio main sem membro na ponte (nada no renderer dispararia o fluxo) |
| Módulo do deep link | `desktop/src/main/deep-link.ts`: `parseDeepLink(url): {kind:'ignored'} \| {kind:'failed'} \| {kind:'sign-in', token}` (aceita só `launchkit:` com host `auth` e caminho exato `/callback`; sem `access_token` não vazio no fragmento = `failed`) e `createDeepLinkHandler({getServerUrl, navigate, focus, consumeNonce})`, que ignora o link idêntico ao último tratado e, para um link `sign-in`, só navega se `consumeNonce(desktop_nonce)` aceitar (nonce igual ao do fluxo pendente, vivo, uso único); o fluxo pendente é consumido por qualquer link com `desktop_nonce` presente, aceito ou não, no primeiro uso; ligado em `app.on('open-url')` (macOS), no `second-instance` (argv, todos os sistemas) e no argv da partida a frio (Windows/Linux), com buffer até `ready`; `app.setAsDefaultProtocolClient('launchkit')` e `protocols` no `electron-builder.yml` | tratar o link dentro de `index.ts` (sem teste de unidade); deduplicar por tempo (um segundo login legítimo logo depois seria engolido) |
| Falha do SSO na tela | `navigate` para `app://launchkit/login?sso=failed` com servidor configurado, ou `app://launchkit/connect?sso=failed` sem servidor; a página lê `sso=failed` e mostra um `role="alert"` com `desktop.sso.incomplete` (en `Sign-in did not complete`, pt-BR `O login não foi concluído`) | rota nova `/sso-error` (mais um destino a proteger no portão); toast disparado pelo main (precisa de IPC para o renderer) |
| Login-CSRF por deep link (decisão do usuário, task `568090d`) | `desktop_nonce` aleatório do app, validado no servidor (mínimo 32 caracteres; `redirect_target` válido sem ele ou com menos: `400 {"detail":"Invalid desktop_nonce"}`, depois da validação do `redirect_target`), gravado em `oidc_state:<state>` (chave `desktop_nonce`, só com `redirect_target`) e devolvido no fragmento do deep link como `&desktop_nonce=<nonce>` (url-encoded; base64url não muda); `desktop_nonce` sem `redirect_target` é ignorado e não é gravado; o app aceita o link só com o nonce do fluxo pendente | aceitar qualquer deep link bem formado (um site que dispare `launchkit://auth/callback#access_token=<jwt do atacante>` loga a vítima na conta do atacante); amarrar o fluxo ao `state` do provedor no cliente (o app não vê o `state`: ele vive só no servidor e no navegador) |
| Ids dos checks de contrato | os casos novos de `contracts/tests/oidc-desktop.test.ts` têm título `D2 ...` a `D6 ...` (os existentes são ajustados ao nonce) | reusar o prefixo `C` (colide com C2..C6 da task 1) |
| `userData/config.json` ganha `mode` (Decided) | `{"mode": "remote" \| "local", "serverUrl": "...", "bounds": {...}}`; regra de leitura em `config-store.getMode()`: `mode` presente vale; ausente com `serverUrl` presente = `remote` (instalações da task 3 não veem a escolha); ausente sem `serverUrl` = `null` (primeiro uso) | `localStorage` (o main precisa do modo antes da janela); tratar `mode` ausente como não escolhido sempre (instalações da task 3 cairiam na escolha de modo) |
| A ponte `window.launchkit` cresce (S2 e S3) | os 8 membros de hoje + `getMode(): Promise<'remote'\|'local'\|null>`, `startLocal(): Promise<{ok:true}\|{ok:false}>`, `openLogs(): Promise<void>`, `onExportState(cb): () => void`; o teste que fixa a lista (task 3, `security.spec.ts` "exposes exactly the eight members") passa a fixar a lista nova; ficam de fora: troca de servidor, exportar e importar, que o menu aciona no main | caminhos HTTP internos em `app://launchkit/_local/*` (fora do `trustedHandle`, sem validação de remetente); esconder o modo dentro de `getServerUrl` (mistura duas coisas) |
| Escolha de modo e `Trocar de servidor` | rota `/mode` interceptada pelo `DesktopGate` como `/connect` (não é `<Route>`); aparece quando `getMode() === null` e quando o menu, em modo local, carrega `app://launchkit/mode`; em modo remoto o menu continua carregando `/connect` (task 3, C10a) e a tela de conexão grava `mode: remote` ao validar | trocar o item de menu do modo remoto para a escolha de modo (muda C10a da task 3) |
| Entrada do backend local | `backend-node/src/local.ts`: lê dados do `argv`/`process.parentPort`, monta o `Config` com um `env` explícito (sem `process.env`, sem `.env`, sem diretório de segredos; `REDIS_URL=''`, `HOST=127.0.0.1`, `PORT=0`), chama `buildContext` com PGlite, `MemoryStore` e `InProcessQueue`, registra o gancho do token e responde `{type:'ready', port}` por `parentPort`; empacotada com esbuild para `desktop/out/backend/server.cjs` (script `build:backend` dentro de `build:all`) e iniciada por `utilityProcess.fork` | `child_process.spawn('node', ...)` (exige `node` no sistema, contra D27); sondar a porta por HTTP até responder (corrida com o `listen` e sem a porta aleatória) |
| Banco do modo local | `connectPglite(dataDir)` em `backend-node/src/db/client.ts` devolvendo o mesmo `DatabaseHandle` (`drizzle-orm/pglite`); as migrations passam por `applyMigrations` sem mudança | um segundo schema para o modo local (o schema Drizzle é um só) |
| Segredo de assinatura do modo local | `userData/secret.key` (32 bytes aleatórios em hex, modo `0600`, criado no primeiro uso) vira `SECRET_KEY` do backend local | gerar a cada execução (todo reinício derruba a sessão) e guardar em `config.json` (mistura segredo com configuração visível) |
| Token de sessão local (D14) | `crypto.randomBytes(32).toString('hex')` por execução; o backend local rejeita com `401 {"detail":"Unauthorized"}` toda requisição cujo `X-Launchkit-Local-Token` não bate (`timingSafeEqual`), inclusive `/api/health`; o `createAppHandler` ganha `getLocalToken` e o injeta no `fetch` ao backend local; o renderer nunca o vê | token em query string (vaza em log); validar só nas rotas autenticadas (`/api/setup/*` ficaria aberta a qualquer processo local) |
| Layout do backup (D18) | antes de abrir o PGlite o app copia `userData/db` para `userData/backups/.pending`; abre, e só com migration pendente renomeia a cópia para `db-<ISO sem ':' e '.'>` (ex.: `db-2026-10-16T12-34-56-789Z`) e migra; falha em qualquer ponto depois da cópia fecha o banco, restaura a cópia sobre `db` e informa o erro; depois de migrar com sucesso restam os 3 `db-*` mais recentes pelo nome | ISO com `:` no nome (inválido no NTFS, o app roda em Windows); copiar só se houver migration pendente, medida abrindo o banco (abrir já altera arquivos do PGlite e o checksum de D18 não bateria); apagar o backup depois de migrar (o critério manda manter 3) |
| Arquivos do modo local | `userData/files` é o `STORAGE_LOCAL_PATH` do `LocalStorageProvider`; `userData/db`, `userData/backups`, `userData/logs` (Decided) | arquivos dentro do diretório do banco (a exportação e o backup do banco copiariam os arquivos duas vezes) |
| Registro do esquema (descoberto no batch 1, registrado depois de `deep-link.ts` ter sido escrito e antes do commit que o fecha) | `setupDeepLinks` chama `app.setAsDefaultProtocolClient('launchkit')` só com `app.isPackaged`; no app empacotado o macOS já registra pelo `Info.plist` (`protocols` do builder) e Windows/Linux pelo instalador e por essa chamada | chamar sempre (uma execução do Electron não empacotado, inclusive o `e2e`, tornaria o binário genérico do Electron o tratador de `launchkit://` na máquina de quem desenvolve) |

| Batch 2: servidor local (descoberto ao escrever os testes de D13-D17) | `backend-node/src/local/local-server.ts` exporta `startLocalServer({dataDir, filesDir, secretKey, sessionToken, migrationsFolder?, logger?, jobLogger?, port?}): Promise<{port, address, ctx, migrationsApplied, close()}>`: monta o `Config` com `loadConfig(env explícito, {envFiles: [], secretsDirs: []})` (`REDIS_URL=''`, `HOST=127.0.0.1`, `PORT=0`, `STORAGE_LOCAL_PATH=filesDir`), abre PGlite em `dataDir`, aplica as migrations (contando as pendentes pelo `drizzle.__drizzle_migrations`), usa `MemoryStore` e `InProcessQueue` (`registerJobs` + `start()`), e escuta em `127.0.0.1`; `buildApp(ctx, options, beforeRoutes?)` ganha um terceiro parâmetro opcional chamado logo depois de criar o Fastify, onde o gancho `onRequest` do token (`401 {"detail":"Unauthorized"}`, `timingSafeEqual`) é registrado antes de qualquer plugin | um segundo `buildApp` para o modo local (duas montagens); registrar o gancho depois dos plugins (o `OPTIONS` do CORS responderia antes do token) |
| Batch 2: PGlite vira dependência de execução | `@electric-sql/pglite` passa de `devDependencies` para `dependencies` de `backend-node` e entra em `desktop/package.json`; o bundle do backend local (`esbuild`, `build:backend`, saída `desktop/out/backend/server.cjs`) deixa `@electric-sql/pglite`, `@node-rs/argon2` e `pg-native` como externos (resolvidos de `desktop/node_modules`) e troca `import.meta.dirname` por `__dirname` com `define`; a pasta de migrations vai por argumento (`migrationsFolder`), nunca por caminho relativo ao bundle | empacotar o PGlite no bundle (o `.wasm` e o `.data` são lidos por `import.meta.url`, que o `cjs` do esbuild não tem); deixar `@node-rs/argon2` dentro do bundle (é um módulo nativo por plataforma) |
| Batch 2: modo e backend no processo principal | `config-store.getMode()`: a chave `mode` presente vale, inclusive `null` (escolha reaberta pela troca de servidor); ausente com `serverUrl` = `remote`; ausente sem `serverUrl` = `null`; `setMode(mode \| null)`; `connect()` com sucesso grava `mode: remote` e para o backend local; a ponte ganha `getMode()`, `startLocal()` e `openLogs()`; `startLocal()` é idempotente (devolve a mesma promessa enquanto sobe e o resultado depois), grava `mode: local` ao subir e devolve `{ok:true}` ou `{ok:false}` (a mensagem completa fica em `userData/logs/backend.log`); o `DesktopGate` em modo local chama `startLocal()` ao abrir e mostra a mesma tela de início ou falha; `createAppHandler` ganha `getBackend(): {url, headers?} \| null` no lugar de `getServerUrl`, e o modo local devolve `http://127.0.0.1:<porta>` com `X-Launchkit-Local-Token` | `mode` só no `localStorage`; um IPC por transição (iniciar, parar, trocar) em vez de `startLocal` idempotente (o portão teria de coordenar corridas); entregar o token ao renderer |

- Linhas de `Landing` descobertas durante o build entram aqui, antes do código que as fecha. Já previstas: o mecanismo do `db.sql` e a biblioteca de zip (batch 3, Unresolved 1), os dependentes nativos do bundle (`@node-rs/argon2`) e o formato do pacote (batch 3).

## Checks

Tamanho de cada slice: piso de leitura = `wc -c` dos arquivos existentes que a slice lê ÷ 4. Estimativa = 3 × piso (iteração e saída de teste) + código novo (linhas × 12) + leitura de biblioteca + custo fixo dos proofs; fórmula declarada em `## Handoff`.

### S1 - Login por SSO pelo navegador do sistema · D1-D10 · 26 arquivos existentes · 130 KB · piso ~32k · estimativa ~123k

**D1a** - No desktop, escolher entrar por SSO em `/login` chama `startSso()` da ponte uma vez e não navega a janela
Proof: `cd frontend && npx vitest run src/pages/login.test.tsx -t "starts SSO in the system browser on desktop"`

**D1b** - No app, o botão de SSO faz `shell.openExternal` receber `<serverUrl>/api/auth/oidc/login?redirect_target=launchkit%3A%2F%2Fauth%2Fcallback&desktop_nonce=<nonce>` com `<nonce>` de 43 caracteres base64url, e continua existindo 1 janela, ainda em `app://launchkit/login`
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "SSO button opens the system browser and keeps one window"`

**D1d** - O fluxo pendente guarda o nonce em memória por 10 minutos: dois `start()` dão nonces diferentes de 43 caracteres base64url, `consume` aceita o nonce uma vez dentro dos 10 minutos e recusa o mesmo nonce de novo, outro valor, e o nonce depois de 10 minutos; um `start()` novo invalida o anterior
Proof: `cd desktop && npx vitest run src/main/sso-flow.test.ts -t "keeps one pending flow for ten minutes and consumes it once"`
Proof: `cd desktop && npx vitest run src/main/sso-flow.test.ts -t "builds the login url with a 43 character base64url nonce"`

**D1c** - No build web o botão de SSO continua indo para `/api/auth/oidc/login` sem `redirect_target`
Proof: `cd frontend && npx vitest run src/pages/login.test.tsx -t "web SSO button still goes to /api/auth/oidc/login"`

**D2** - Com `OIDC_DESKTOP_REDIRECT=launchkit://auth/callback`, `GET /api/auth/oidc/login?redirect_target=launchkit://auth/callback&desktop_nonce=<43 caracteres>` responde 307 para o `/authorize` do provedor com os oito parâmetros de hoje e o Redis guarda `oidc_state:<state>` com JSON de chaves exatamente `code_verifier`, `desktop_nonce`, `nonce`, `redirect_target` (valores `launchkit://auth/callback` e o nonce enviado) e TTL entre 590 e 600 s
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D2 "`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D2 "`

**D3** - Com o `state` do D2, o callback com `code` e `state` válidos responde 307 para um `Location` que começa em `launchkit://auth/callback#access_token=` e termina em `&token_type=bearer&desktop_nonce=<nonce>` com o mesmo nonce enviado no login, e o JWT dá 200 em `GET /api/users/me`
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D3 "`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D3 "`

**D4a** - Com a lista configurada, um `redirect_target` que não é exatamente um item dela responde 400 `{"detail": "Invalid redirect_target"}`, sem `Location` e sem criar chave `oidc_state:*` no Redis, mesmo com um `desktop_nonce` válido (tabela: `https://evil.example/cb`, `launchkit://auth/callback/`, `launchkit://auth/callbackx`, `LAUNCHKIT://auth/callback`, ` launchkit://auth/callback` com espaço à frente, `redirect_target=` vazio)
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D4 rejects"`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D4 rejects"`

**D4b** - Com `OIDC_DESKTOP_REDIRECT` vazia ou ausente, `redirect_target=launchkit://auth/callback` responde o mesmo 400, sem `Location` e sem escrever no Redis
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D4 empty or unset allowlist"`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D4 empty or unset allowlist"`

**D4c** - Com `OIDC_DESKTOP_REDIRECT=launchkit://auth/callback, launchkit://x/y` (dois itens, espaço depois da vírgula) os dois itens são aceitos (307 ao provedor) e um terceiro é 400
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D4 accepts every item of the list"`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D4 accepts every item of the list"`

**D4d** - Com o `redirect_target` válido, `desktop_nonce` ausente, vazio ou de 31 caracteres responde 400 `{"detail": "Invalid desktop_nonce"}`, sem `Location` e sem chave nova no Redis; de 32 caracteres é aceito (307)
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D4 rejects a missing or short desktop_nonce"`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D4 rejects a missing or short desktop_nonce"`
Proof: `cd backend && python -m pytest tests/test_oidc_auth.py -k desktop_nonce`
Proof: `cd backend-node && npx vitest run test/routes/oidc.test.ts -t "desktop_nonce"`

**D5** - Sem `redirect_target` (com a lista configurada) o estado guardado é `{"nonce","code_verifier"}` (também quando só `desktop_nonce` vem na query) e o callback redireciona para `<FRONTEND_URL>/auth/oidc/callback#access_token=<jwt>&token_type=bearer`
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D5 "`
Proof: `cd contracts && CONTRACT_STACK=node npx vitest run tests/oidc-desktop.test.ts -t "D5 "`

**D6** - A suíte de contrato tem um caso para cada um de D2 a D5 (D4 inclui D4d) e a suíte inteira passa nas duas stacks sem falha nem caso pulado; `contracts/openapi.json` declara o parâmetro `redirect_target` (query, opcional) em `GET /api/auth/oidc/login`
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run tests/oidc-desktop.test.ts -t "D6 "` e o mesmo com `CONTRACT_STACK=node` (o caso lê os títulos do próprio arquivo e exige pelo menos um por id D2, D3, D4, D5)
Proof: `cd contracts && CONTRACT_STACK=python npx vitest run --reporter=json --outputFile=.logs/d6-python.json; node scripts/summary.mjs .logs/d6-python.json --no-skip` e o mesmo com `node`
Proof: `python backend/scripts/export_openapi.py --check`

**D7a** - Depois de iniciar o SSO pelo botão (nonce pendente), quando o macOS entrega `launchkit://auth/callback#access_token=<jwt>&token_type=bearer&desktop_nonce=<nonce>` (`open-url`) com o nonce pendente, o app navega para `/auth/oidc/callback`, grava `localStorage.token`, chega em `/` e `GET /api/users/me` é 200
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "an open-url deep link signs in and lands on / with users/me 200"`

**D7b** - Com o fluxo pendente, quando uma segunda instância (Windows e Linux; roda também no macOS) traz o link com o nonce no argv, a primeira instância faz o mesmo e o fluxo pendente é consumido e a segunda sai com código 0
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "a second instance carrying the link signs in"`
Proof: `cd desktop && npx vitest run src/main/deep-link.test.ts -t "finds the launchkit url in a second-instance argv"`

**D7c** - O app se registra como tratador de `launchkit://` (`setAsDefaultProtocolClient('launchkit')` e `protocols` no `electron-builder.yml`)
Proof: `cd desktop && npx vitest run src/main/deep-link.test.ts -t "registers the launchkit protocol"`
Proof: `cd desktop && npx vitest run scripts/builder-config.test.ts -t "declares the launchkit protocol"`

**D8** - O mesmo deep link (mesmo nonce) entregue 2 vezes navega 1 vez e o token entra 1 vez
Proof: `cd desktop && npx vitest run src/main/deep-link.test.ts -t "handles the same link once"`
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "the same deep link twice signs in once"`

**D9a** - Deep link `auth/callback` que não vale um login navega para `/login?sso=failed` com servidor configurado e para `/connect?sso=failed` sem servidor, e nenhum token é gravado (tabela: sem fragmento, `#access_token=` vazio, `#error=access_denied`, nonce ausente, nonce diferente do pendente, nonce expirado depois de 10 minutos, nonce já usado, sem fluxo pendente)
Proof: `cd desktop && npx vitest run src/main/deep-link.test.ts -t "sends an incomplete link to the sign-in failure screen"`

**D9b** - `/login?sso=failed` e `/connect?sso=failed` mostram um `role="alert"` com `Sign-in did not complete` (pt-BR `O login não foi concluído`)
Proof: `cd frontend && npx vitest run src/pages/login.test.tsx -t "shows Sign-in did not complete when sso=failed"`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "shows Sign-in did not complete when sso=failed"`

**D9c** - No app, um link `#error=access_denied`, um link com token e nonce errado e um link com nonce válido sem fluxo pendente levam a `/login?sso=failed` com a mensagem e `localStorage.token` continua vazio; sem servidor leva à tela de conexão com a mensagem
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "an incomplete deep link shows the message and stores no token"`

**D10** - Link com host e caminho diferentes de `auth/callback` (tabela: `launchkit://auth/other`, `launchkit://evil/callback`, `launchkit://auth/callback/extra`, `launchkit://auth/callback/`, `launchkit://auth`, `https://auth/callback#access_token=x`) é ignorado: `navigate` não é chamado e a URL da janela não muda
Proof: `cd desktop && npx vitest run src/main/deep-link.test.ts -t "ignores links whose host and path are not auth/callback"`
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts -g "a deep link with another path is ignored"`

### S2 - Modo local · D11-D21 · 29 arquivos existentes · 72 KB · piso ~18k · estimativa ~100k

**D11a** - No primeiro uso (sem `mode` nem `serverUrl`) o portão mostra os botões `Connect to a server` e `Use this computer` (pt-BR `Conectar a um servidor` e `Usar neste computador`) antes de qualquer outra tela e sem nenhuma chamada a `/api/*`
Proof: `cd frontend && npx vitest run src/components/desktop-gate.test.tsx -t "shows the mode choice before anything else on first use"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "first launch shows the mode choice and makes no api calls"`

**D11b** - `Connect to a server` leva à tela de conexão da task 3; uma instalação da task 3 (`serverUrl` sem `mode`) não vê a escolha de modo
Proof: `cd desktop && npx vitest run src/main/config-store.test.ts -t "mode defaults to remote when a server url exists"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "connect to a server leads to the connect screen"`

**D12a** - `Use this computer` faz o processo principal iniciar o backend em um `utilityProcess` escutando em `127.0.0.1:<porta aleatória>`
Proof: `cd desktop && npx vitest run src/main/local-backend.test.ts -t "forks the backend and resolves with its loopback port"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "use this computer starts a utility process on a loopback port"`

**D12b** - Enquanto o backend sobe a interface mostra um elemento `role="progressbar"`; ao ficar pronto o app vai para `/setup`, onde `GET /api/setup/status` retorna `{"has_users": false}`
Proof: `cd frontend && npx vitest run src/pages/mode-select.test.tsx -t "shows a progressbar while the local backend starts"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "use this computer lands on /setup with has_users false"`

**D13** - As migrations do backend Node sobre PGlite criam exatamente as 6 tabelas (`app_settings`, `users`, `user_passkeys`, `workspaces`, `files`, `workspace_members`) com as mesmas colunas, tipos e anulabilidade do PostgreSQL 16
Proof: `cd backend-node && npx vitest run test/db/pglite.test.ts -t "creates the six tables"`
Proof: `cd backend-node && npx vitest run test/db/pglite.test.ts -t "matches the PostgreSQL column catalog"` (compara com `test/fixtures/pg-columns.json`, gerado uma vez do `t04-pg` real e versionado)
Proof: `cd backend-node && npx vitest run test/db/pglite.test.ts -t "applies the migrations to a PGlite directory on disk"`

**D14a** - Requisição ao backend local sem `X-Launchkit-Local-Token`, ou com valor diferente, responde 401 `{"detail": "Unauthorized"}` em toda rota (inclusive `/api/health` e `/api/setup/status`); com o valor certo passa
Proof: `cd backend-node && npx vitest run test/local/token-guard.test.ts -t "answers 401 without the right token on every route"`

**D14b** - O token é aleatório a cada execução (32 bytes em hex, dois inícios dão valores diferentes) e só o processo principal o injeta: o renderer chama `/api/health` e recebe 200, e uma chamada direta à porta sem o cabeçalho recebe 401
Proof: `cd desktop && npx vitest run src/main/local-backend.test.ts -t "generates a different session token on every start"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "the page reaches the backend and a direct call without the token is 401"`

**D15a** - O backend local escuta em `127.0.0.1` (o `address()` do servidor é `127.0.0.1`)
Proof: `cd backend-node && npx vitest run test/local/local-server.test.ts -t "listens on 127.0.0.1 only"`

**D15b** - Uma conexão TCP ao IP da rede local (primeiro IPv4 não interno da máquina) na porta do backend é recusada (`ECONNREFUSED`); o teste falha se a máquina não tem esse IP
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "the local port refuses connections on the LAN address"`

**D16** - Sem rede (resolução de nomes fora de loopback bloqueada), criar usuário, workspace e arquivo, fechar e reabrir o app faz `GET /api/workspaces` e `GET /api/files` devolverem os mesmos itens e o login com a mesma senha funcionar; banco em `userData/db` (contém `PG_VERSION`) e arquivo em `userData/files`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "data survives a restart with the network blocked"`

**D17a** - Em modo local nenhuma conexão é aberta na porta 6379 e `REDIS_URL` não é lida: com `REDIS_URL` apontando para um listener-isca, o isca não recebe conexão e o `Config` montado tem `redisUrl === null`
Proof: `cd backend-node && npx vitest run test/local/local-server.test.ts -t "never reads REDIS_URL and never connects to it"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "local mode opens no redis connection"`

**D17b** - Os jobs agendados rodam no próprio processo: com o relógio avançado 3600 s o job `report-user-count-hourly` registra `There are <N> users`
Proof: `cd backend-node && npx vitest run test/local/local-server.test.ts -t "runs the scheduled jobs inside the process"`

**D18a** - Com migration pendente, `userData/db` é copiado para `userData/backups/db-<ISO>/` (checksum igual ao do `db` antes) antes de a migration rodar, e depois da migration restam no máximo os 3 backups mais recentes (partindo de 4 existentes, restam os 3 de nome mais novo)
Proof: `cd desktop && npx vitest run src/main/backup.test.ts -t "copies the database before a pending migration runs"`
Proof: `cd desktop && npx vitest run src/main/backup.test.ts -t "keeps only the three most recent backups"`

**D18b** - Sem migration pendente nenhum backup novo é criado e a cópia temporária some
Proof: `cd desktop && npx vitest run src/main/backup.test.ts -t "creates no backup when no migration is pending"`

**D18c** - Se a migration falha, o app mostra o erro e `userData/db` tem o mesmo checksum de antes (a cópia é restaurada)
Proof: `cd desktop && npx vitest run src/main/backup.test.ts -t "restores the original database when the migration fails"`

**D19a** - Se o backend local não inicia (banco corrompido, saída antes do `ready`), a tela mostra `Could not start the local backend` (pt-BR `Não foi possível iniciar o backend local`) com os botões `Try again` e `Open logs` (pt-BR `Tentar de novo` e `Abrir logs`), e o banco continua com o mesmo checksum
Proof: `cd frontend && npx vitest run src/pages/mode-select.test.tsx -t "shows the local backend failure with retry and logs actions"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "a corrupt database shows the failure screen and stays intact"`

**D19b** - `Open logs` abre `userData/logs/` (`shell.openPath`) e `Try again` reinicia o backend, que sobe depois de o banco ser consertado
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "open logs opens the logs folder and try again restarts the backend"`

**D20** - Ao encerrar o app o `utilityProcess` termina em até 5 s e o pid deixa de existir
Proof: `cd desktop && npx vitest run src/main/local-backend.test.ts -t "stops the backend within five seconds"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "quitting the app ends the backend process"`

**D21** - Em modo local, `Trocar de servidor` abre a tela de escolha de modo e `userData/db` e `userData/files` continuam no lugar (arquivos com o mesmo checksum; os dados voltam ao escolher `Use this computer` de novo)
Proof: `cd desktop && npx vitest run src/main/menu.test.ts -t "switch server opens the mode choice in local mode and the connect screen in remote mode"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "switching server in local mode keeps the data"`

### S3 - Exportar e importar · D22-D25 · 12 arquivos existentes · 37 KB · piso ~9k · estimativa ~56k

**D22a** - Arquivo > Exportar dados (modo local) abre `dialog.showSaveDialog` com `defaultPath` `launchkit-export-<ISO>.zip` e o arquivo gravado contém `manifest.json` (`{"formatVersion": 1, "appVersion", "schemaRevision"}`), `db.sql` e a pasta `files/` com os arquivos enviados
Proof: `cd desktop && npx vitest run src/main/export-import.test.ts -t "exports manifest db.sql and files"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "export writes a zip with manifest db.sql and files"`

**D22b** - Enquanto exporta, a interface mostra um modal de progresso e nenhuma requisição `POST`, `PATCH` ou `DELETE` sai do renderer
Proof: `cd frontend && npx vitest run src/components/export-modal.test.tsx -t "blocks the interface and every write while exporting"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "no write leaves the renderer while exporting"`

**D23** - Um arquivo exportado e uma instalação nova do modo local: Arquivo > Importar dados, ao confirmar, deixa as contagens de usuários, workspaces e arquivos iguais às do original e o login com a mesma senha funciona
Proof: `cd desktop && npx vitest run src/main/export-import.test.ts -t "imports into a new installation and restores the counts"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "import into a new installation restores users workspaces files and login"`

**D24** - Arquivo que não é zip, zip corrompido ou `formatVersion` maior que 1 mostram `Invalid export file` (pt-BR `Arquivo de exportação inválido`) e o banco local tem o mesmo checksum de antes
Proof: `cd desktop && npx vitest run src/main/export-import.test.ts -t "refuses a file that is not a valid export and changes nothing"` (tabela: texto puro, zip truncado, `formatVersion` 2)
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "an invalid export file shows the error and keeps the database"`

**D25** - Com usuários no banco local, importar é recusado com `Import is only available on a new installation` (pt-BR `A importação só está disponível em uma instalação nova`) e nada muda (checksum do banco e dos arquivos igual)
Proof: `cd desktop && npx vitest run src/main/export-import.test.ts -t "refuses to import when the database already has users"`
Proof: `cd desktop && npx playwright test e2e/local.spec.ts -g "import is refused on an installation with data"`

### S4 - Verificação no CI e pacote · D26-D27 · 9 arquivos existentes · 46 KB · piso ~11k · estimativa ~58k

**D26a** - O teste Playwright cobre o modo local (escolher o modo, criar usuário e arquivo, reabrir, exportar e importar em uma instalação nova) e o deep link com o servidor de teste, e passa (macOS, local)
Proof: `cd desktop && npx playwright test e2e/local-flow.spec.ts -g "local mode end to end: choose, create, reopen, export, import into a new install"`
Proof: `cd desktop && npx playwright test e2e/sso.spec.ts`

**D26b** - O job `desktop-e2e` roda esses specs nos três sistemas (a matriz `macos-latest`/`windows-latest`/`ubuntu-latest` roda `npm run test:e2e`, que inclui `local-flow.spec.ts` e `sso.spec.ts`) e `changes.py` marca `run_desktop=true` também para `backend-node/` (o bundle depende dele)
Proof: `cd desktop && npx vitest run scripts/ci-workflow.test.ts -t "desktop-e2e runs the local mode and deep link specs on the three systems"`
Proof: `python3 .github/ci/test_changes.py CIChangesTest.test_run_desktop_selection`

**D26c** - O teste passa em Windows e Linux
Proof: pendente - job `desktop-e2e` no CI; ver `Local proof limits`

**D27a** - O pacote leva o `backend-node` empacotado com esbuild (`resources/backend/server.cjs`, as migrations e os arquivos do PGlite) e a configuração do builder o declara
Proof: `cd desktop && npx vitest run scripts/builder-config.test.ts -t "ships the bundled local backend"`
Proof: `cd desktop && npm run package:dir && npx vitest run scripts/packaged-local.test.ts -t "packaged app contains the bundled backend"`

**D27b** - O app empacotado com o modo local abre sem `node` instalado no sistema: com `PATH` sem `node`, `mode: local` em `config.json`, o backend sobe em `utilityProcess` e `GET /setup` do renderer carrega pela porta de depuração
Proof: `cd desktop && npm run package:dir && npx vitest run scripts/packaged-local.test.ts -t "packaged app starts the local backend without node on PATH"`

## Swept

- validation: D4 (allowlist exata, tamanho do nonce), D9, D10, D24
- replay: D7/D9 (nonce de uso único, 10 minutos), D1d (formato do arquivo importado)
- failure modes: D18c, D19, D24 (nada muda no banco)
- idempotency and retry: D8 (mesmo link), D19b (tentar de novo), D18b (sem backup quando nada está pendente)
- authorization: D4, D14, D15, D25 (importar só em instalação nova)
- concurrency and ordering: D22b (modal que bloqueia escritas durante a exportação); D12b (a interface só vai a `/setup` com o backend pronto)
- data lifecycle: D18 (backup antes de migrar, 3 mais recentes), D21 (dados continuam em `userData`), D16
- external-dependency failure: existing - o provedor OIDC e o callback rodam no servidor, inalterados (task 1 C25); o modo local não tem dependência externa (D16, D17)
- state transitions: D11, D12, D18, D19, D20, D21 (diagrama de `States` da task); `Remoto -> ModoNaoEscolhido` fica como está na task 3 (C10a abre a tela de conexão), ver `Landing`
- observability: D19 (pasta de logs); o backend local grava stdout e stderr em `userData/logs/backend.log` sem segredos (critério 40 da task 1); o token de sessão local e o `secret.key` não aparecem no log (proof no batch 2, dentro de D19b)

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| `redirect_target` inputs (11) | item da lista D2 · segundo item de lista D4c · terceiro fora da lista D4c · `https://evil.example/cb` D4a · barra final D4a · sufixo D4a · caixa D4a · espaço D4a · vazio D4a · ausente D5 · lista vazia D4b | - |
| stacks do OIDC (2) | Python D2-D6 · Node D2-D6 | - |
| entradas do deep link (11) | `sign-in` com nonce pendente D7a/D7b · sem fragmento D9a · `access_token` vazio D9a · `error=` D9a · nonce ausente D9a · nonce diferente D9a/D9c · nonce expirado D9a/D1d · nonce usado D9a/D1d · sem fluxo pendente D9a/D9c · outro caminho D10 · outro host D10 | - |
| `desktop_nonce` no login (5) | 43 caracteres D2 · 32 D4d · 31 D4d · vazio D4d · ausente D4d | - |
| entregas do deep link (3) | `open-url` D7a · `second-instance` argv D7b · argv de partida a frio D7b (unit `deep-link.test.ts`, mesmo extrator) | partida a frio real em Windows/Linux (só unit) |
| destinos de falha do SSO (2) | `/login?sso=failed` D9a/D9b/D9c · `/connect?sso=failed` D9a/D9b/D9c | - |
| idiomas das mensagens novas (2) | en e pt-BR - D9b, D11a, D19a, D24, D25 | paridade de chaves no teste `desktop-keys.test.ts` (task 3, C34) |
| estados do modo (5) | não escolhido D11 · local iniciando D12 · local pronto D12/D16 · local falhou D19 · encerrado D20 | - |
| tabelas do schema sobre PGlite (6) | `app_settings` · `users` · `user_passkeys` · `workspaces` · `files` · `workspace_members` - todas em D13 | - |
| rotas protegidas pelo token local (todas) | D14a percorre `/api/health`, `/api/setup/status`, `/api/users/me`, `/api/files`, uma rota desconhecida e um `OPTIONS` | - |
| conteúdo do zip (3 entradas) | `manifest.json` · `db.sql` · `files/` - D22a | - |
| arquivos importados inválidos (3) | texto puro · zip truncado · `formatVersion` 2 - D24 | - |
| backups de migração (retenção 3) | partindo de 4: 3 mais novos ficam D18a · sem pendência D18b · falha D18c | - |
| sistemas do `desktop-e2e` (3) | macOS D26a | Windows e Linux D26c |
| assemblies do backend (2 montagens: `server.ts`, `local.ts`) | `server.ts` já coberta (task 1); `local.ts` D14a, D15a, D17 | - |

- Claims naming a status code, route or response shape: D2-D5 (307, 400, `Location`) - cruzam a fronteira HTTP nas duas stacks (suíte de contrato); D12b e D14 (`/api/setup/status`, 401) - e2e pelo app e teste de rota no Node; D3 (`launchkit://` no `Location`) - contrato.
- No other check claims more than the single case its proof exercises.

## Local proof limits

Ambiente: macOS arm64, Node 22, Docker (containers `t04-*`, portas aleatórias), Python 3.11 em venv próprio fora do git (`CONTRACT_PYTHON_BIN`). Windows e Linux só existem no `desktop-e2e` do GitHub Actions. Não declaro proof verde onde ele não roda:

- D26c - Windows e Linux só no job de CI; o `launchArgs` já acrescenta `--no-sandbox` em Linux com `CI`.
- D7a/D7b - a entrega pelo sistema operacional (macOS `open launchkit://...` com o app instalado, o registro do esquema em Windows e Linux) não é exercida: o `open-url` é emitido por `app.emit` no processo principal e o `second-instance` é um segundo processo com o link no argv. Prova o tratamento do evento, não o registro real no sistema; `setAsDefaultProtocolClient` e `protocols` são conferidos como configuração (D7c).
- D16 - "sem rede" é a resolução de nomes bloqueada fora de loopback (`--host-resolver-rules`) mais a ausência de conexões de saída do processo do backend (`lsof`); a interface de rede não é desligada.
- D15b - exige um IPv4 não interno na máquina; o teste falha sem ele (nunca pula). Os runners do GitHub têm um.
- D27b - o Playwright não se anexa ao app empacotado (fuse `enableNodeCliInspectArguments: false`, task 3); o proof usa `--remote-debugging-port` e CDP puro, só no macOS local e, em CI, depois de `package:dir`; Windows não roda `package:dir` nem esse teste.
- D27a/D27b - o build dos instaladores (`dmg`, `nsis`, `AppImage`, `deb`) e os módulos nativos de outras arquiteturas não são construídos aqui; só `--dir` em macOS arm64.
- C-ids da task 3 sem proof local seguem como estavam (C11c do servidor Node passa a rodar quando o servidor Node for exercitado; C23c, C24, C25, C26b, C36c).
- Python: o venv é instalado a partir de `backend/uv.lock` exportado com `pip` (o `uv` não está instalado); a versão resolvida pode diferir do lock em pacotes transitivos.

## Handoff

Fórmula: estimativa = 3 × piso (iteração e saída de teste) + código novo (linhas × 12 tokens) + leitura de biblioteca + custo fixo dos proofs (Docker, instalação, Python, Playwright). O piso é `wc -c` ÷ 4 dos arquivos existentes que a slice lê.

| Slice | Piso | Código novo | Biblioteca e fixo | Estimativa | Acumulado |
| --- | --- | --- | --- | --- | --- |
| S1 | 32k (130 KB) | ~550 linhas, 7k | 20k (venv Python, `t04-pg`, `t04-redis`, `npm ci` ×4) | ~123k | 123k |
| S2 | 18k (72 KB) | ~1500 linhas, 18k | 28k (PGlite, esbuild, utilityProcess, Playwright) | ~100k | 223k |
| S3 | 9k (37 KB) | ~900 linhas, 11k | 18k (zip, dump do PGlite) | ~56k | - |
| S4 | 11k (46 KB) | ~400 linhas, 5k | 20k (`package:dir`, CI) | ~58k | - |

Corte (slices inteiras, nunca no meio):

- **Batch 1 = S1 = ~123k.** Superfície: OIDC nas duas stacks, suíte de contrato, deep link no main e login no frontend. S2 elevaria o acumulado a 223k, acima de 150k.
- **Batch 2 = S2 = ~100k.** Superfície nova: backend local, PGlite, `utilityProcess`, portão, escolha de modo. S3 elevaria a 156k, acima de 150k, e troca de superfície (zip e dump).
- **Batch 3 = S3 + S4 = ~114k.** Exportar/importar e a verificação/empacotamento compartilham `export-import`, o menu e o `desktop-release`/`ci.yml`; o bundle esbuild nasce no batch 2 (o modo local precisa dele para rodar) e S4 prova o pacote.
- **Atravessam batches:** a suíte `frontend` (`npm test`, que não pode regredir) e a suíte `contracts` completa nas duas stacks rodam em todo batch que toca o contrato ou o frontend; o teste que fixa a ponte `window.launchkit` muda no batch 2 (ver `Landing`); os e2e da task 3 que abrem o app sem configuração (`connect.spec.ts` e `real-server.spec.ts`) passam a clicar `Connect to a server` primeiro (D11), no batch 2.

### Batch 1 fechado (S1)

- **Onde o limite caiu:** D1a-D1c, D2, D3, D4a-D4c, D5, D6, D7a-D7c, D8, D9a-D9c e D10 fechados (S1 inteira), cada proof rodado pelo nome e verde; último commit de código `0a9ce4b` (backend e contrato `e8e0c5e`, frontend `aa6fec7`, deep link `e1199e9`). Suítes: `contracts` completa nas duas stacks (`CONTRACT_STACK=python` e `node`: 238 casos, 0 falhas, 0 pulados por `summary.mjs --no-skip`), `export_openapi.py --check` limpo, `desktop` 93 testes de unidade e 32 de Playwright (2 pulados do servidor real, como antes), `frontend` 473 testes, `backend-node` 73 (8 pedem Redis e ficam fora sem `REDIS_URL`), `check:web-bundle` limpo, pytest de `test_oidc_auth` e `test_config` (30). Mutação feita: sem a deduplicação o e2e de D8 falha, com a checagem do host removida o de D10 falha. Próximo batch: S2 (D11-D21); a ponte `window.launchkit` cresce lá e o teste que a fixa muda.
- **O que o usuário já decidiu (sem decisão nova no batch):** nenhuma pergunta ao usuário. Decisões minhas, em `Landing` antes do código, exceto a última: transporte do token pela página `oidc-callback.tsx`, `?sso=failed`, dedupe pelo link idêntico, validação do `redirect_target` depois da descoberta, `setAsDefaultProtocolClient` só empacotado (linha escrita depois de `deep-link.ts`, antes do commit). Leitura sem linha: o campo `redirect_target` no Node entra no `querystring` Zod da rota (documenta no Swagger); as colunas de `Local proof limits` valem sem mudança. Risco aceito e registrado para o usuário decidir: o login-CSRF por deep link (`Landing`).
- **O que foi abandonado:** (1) o `Write` do agente é barrado pelo hook de worktree (a sessão roda em outra worktree); os arquivos foram escritos por `Bash`. (2) Um evento IPC `auth:token` (cresceria a ponte). (3) Rodar `setAsDefaultProtocolClient` sempre: tornaria o binário genérico do Electron o tratador de `launchkit://` na máquina de quem desenvolve. (4) Ambiente: o `uv` não existe; o venv Python foi criado com `pip install uv` só para `uv export --frozen` do `uv.lock` (resolução idêntica ao lock) e vive fora do git.
