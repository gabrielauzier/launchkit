# Desktop com Electron: cliente de um servidor remoto

Profile: `light` · handoff `on` · budget 150k · sem design binding (a tela de conexão reusa o cartão de `frontend/src/pages/login.tsx`; perfil `ui` não se aplica).

Sources:

- `.tasks/03-desktop-cliente-remoto.md` - record of decision: 38 critérios em 7 slices, `Decided`, `Unresolved`. Os números `C<n>` abaixo são os números dos critérios; um critério com "e" vira `C<n>a`, `C<n>b`…
- `docs/prds/prd-feature-2-electron-desktop.md` - histórias 1 a 6, FR-001 a FR-009, NFR-001 a NFR-006.
- `docs/plans/feature-2-electron-desktop.md` - D1 a D6 e D8, fases 0 a 2.
- Decisões do usuário confirmadas fora da task: electron-builder; `appId` `com.launchkit.desktop`; releases do desktop em repositório separado do servidor (valor de teste configurável, go-live registrado); URL sem protocolo é recusada; trocar de servidor apaga a sessão sem confirmação; sem logs próprios no cliente remoto.

## Out of scope

- OIDC/SSO e modo local com backend embutido - task 4.
- Passkeys no desktop - WebAuthn limitado no Electron e a origem `app://` não bate com o RP ID.
- Token em Keychain/DPAPI/libsecret, bandeja, notificações nativas, abrir ao iniciar - P2 do PRD.
- Sincronização local/servidor, apps móveis, visual nativo por sistema.
- Segredos e certificados de assinatura (Apple e Windows) - não existem; ver `Local proof limits`.

## Landing

Toca: pacote novo `desktop/` (main, preload, shared, e2e); `frontend/` ganha `src/lib/platform.ts`, `src/pages/connect-server.tsx`, `src/components/desktop-gate.tsx`, ajustes pontuais atrás de `isDesktop()` e uma alteração aditiva em `vite.config.ts`; `.github/ci/*` e `ci.yml` só com edições aditivas (batch 3). Reaproveita `Card`/`Input`/`Button`, `api.ts` (`baseURL: '/api'` intacto), `use-feature-flags`, i18n.

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| Protocolo `app://launchkit` (Decided) | `protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true, supportFetchAPI:true}}])` antes de `ready`; `protocol.handle('app', handler)`; `handler` é uma função pura `(Request)=>Promise<Response>` criada por `createAppHandler({distDir, getServerUrl, fetchFn})` | `file://` (`BrowserRouter`/`baseURL` quebram); `http://localhost` embutido (porta aberta a qualquer processo) |
| Encaminhamento de `/api/*` | `app://launchkit/api/<p>` -> `fetchFn(<serverUrl>/api/<p>, {method, headers sem origin/referer/host, body, duplex:'half', redirect:'manual'})`; sem `serverUrl` responde 503 sem sair da máquina | repassar `Origin: app://launchkit` e exigir CORS no servidor (viola C14) |
| Contrato `window.launchkit` (Decided, 8 membros) | `isDesktop: true`, `platform: NodeJS.Platform`, `appVersion: string`, `getServerUrl(): Promise<string\|null>`, `setServerUrl(url, opts?: {allowInsecure?: boolean}): Promise<{ok:true,url:string}\|{ok:false,reason:'invalid-url'\|'insecure'\|'unreachable'}>`, `openExternal(url): Promise<void>`, `onUpdateAvailable(cb): () => void`, `installUpdate(): Promise<void>` | validar a URL no renderer (CSP `connect-src 'self'` e falta de CORS impedem); expor `ipcRenderer` |
| Dono das regras de URL | só o processo principal: normaliza (tira `/` final), exige `http://`/`https://`, avisa `http` fora de `localhost`/`127.0.0.1`/`[::1]`, valida por `/api/health` + `/api/info`, grava; o renderer só mostra o `reason` | regras duplicadas no renderer (diverge) |
| `userData/config.json` (Decided) | `{"serverUrl": "https://host", "bounds": {"x":0,"y":0,"width":0,"height":0}}`, gravação atômica (arquivo temporário + rename); `serverUrl` ausente = não configurado | `localStorage` do renderer (apagável por script do renderer) |
| Flag de compilação `__DESKTOP_BUILD__` | `define` do Vite: `true` só com `vite build --mode desktop`; o único texto `window.launchkit` fora de `?.isDesktop` vive em `getDesktopApi()` de `platform.ts` atrás de `__DESKTOP_BUILD__ ? … : null`; `App.tsx` só importa a tela de conexão nesse ramo. Vitest define `true` | checar `window.launchkit` em runtime nas páginas (o bundle web passaria a referenciá-lo; viola C38) |
| Saída do build desktop do frontend | `frontend/dist-desktop/` (`build.outDir` por modo; `dist/` do web não muda) | sobrescrever `dist/` (corrompe o build web local) |
| Renderer não é construído pelo electron-vite | `desktop/electron.vite.config.ts` só com `main` e `preload`; o renderer é `frontend/dist-desktop/` | `renderer` do electron-vite apontando para `frontend/` (duplica aliases/tailwind e deriva do build web) |
| `appVersion` no preload | passado por `webPreferences.additionalArguments: ['--launchkit-app-version=<v>']`, lido de `process.argv` no preload (`sandbox: true`) | `ipcRenderer.sendSync` (bloqueia o renderer e abre mais um canal de IPC) |
| Pacote `desktop/` | `package.json` próprio com `package-lock.json`, fora de workspaces; `npm ci` em `desktop/` e em `frontend/` | monorepo com workspaces (muda o lock e o CI do frontend) |
| Repositório de releases | `publish: {provider: github, owner/repo de ${env.LAUNCHKIT_DESKTOP_RELEASE_REPO}}`; go-live em `Unresolved` 2 (batch 3) | valor fixo (o repositório não existe) |

- Linhas adicionais de `Landing` descobertas durante o build entram aqui, antes do código que as fecha.

## Checks

Tamanho de cada slice: piso de leitura = `wc -c` dos arquivos existentes que a slice lê ÷ 4. Estimativa de trabalho = 3 × piso (iteração, saída de teste) + código novo (linhas × 12) + custo fixo de execução dos proofs; fórmula declarada em `## Handoff`.

### S1 - Abrir o app · C1-C3 · 4 arquivos existentes · 8 KB · piso ~2k · estimativa ~34k

**C1** - Ao abrir o app há 1 janela e a URL dela começa com `app://launchkit/`
Proof: `cd desktop && npx playwright test e2e/launch.spec.ts -g "opens exactly one window at app://launchkit/"`

**C2a** - O handler do protocolo responde 200 com `index.html` para uma rota desconhecida (`/files`) e 200 com o arquivo para um asset existente
Proof: `cd desktop && npx vitest run src/main/app-protocol.test.ts -t "serves index.html with 200 for unknown routes"`
Proof: `cd desktop && npx vitest run src/main/app-protocol.test.ts -t "serves an existing asset with its content type"`

**C2b** - Recarregar a janela em `app://launchkit/files` renderiza a página de arquivos
Proof: `cd desktop && npx playwright test e2e/launch.spec.ts -g "reloading /files keeps the files page"`

**C3a** - Abrir uma segunda instância encerra o novo processo com código 0 e `BrowserWindow.getAllWindows().length` continua 1
Proof: `cd desktop && npx playwright test e2e/launch.spec.ts -g "second instance exits 0 and leaves one window"`

**C3b** - O evento `second-instance` restaura a janela minimizada e dá foco a ela
Proof: `cd desktop && npx vitest run src/main/single-instance.test.ts -t "restores a minimized window and focuses it"`

### S2 - Conectar a um servidor · C4-C10 · 11 arquivos existentes · 88 KB · piso ~22k · estimativa ~81k

**C4a** - Sem servidor configurado, a tela de conexão (título `Connect to a server` em en, `Conectar a um servidor` em pt-BR) aparece no lugar de `/setup` e de `/login`
Proof: `cd frontend && npx vitest run src/components/desktop-gate.test.tsx -t "shows the connect screen instead of setup and login"`

**C4b** - Sem servidor configurado, nenhuma chamada a `/api/*` sai do renderer
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "first run shows the connect screen and makes no api calls"`

**C5** - Com o campo de URL vazio, o botão de confirmar fica desabilitado
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "confirm is disabled while the url is empty"`

**C6a** - Confirmar uma URL faz `GET <url>/api/health` (200 `{"status":"healthy"}`) e `GET <url>/api/info` (200 com `app_name`)
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "calls health then info on the server"`

**C6b** - Durante a chamada o botão fica desabilitado com `Checking…` (pt-BR `Verificando…`)
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "shows a disabled Checking button while connecting"`

**C6c** - Validado o servidor, a URL é salva
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "saves the normalized url after a healthy server"`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "connecting saves the url in config.json"`

**C6d** - Com `GET /api/setup/status` = `{"has_users": false}` navega para `/setup`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "goes to /setup when the server has no users"`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "fresh server lands on /setup"`

**C6e** - Com `{"has_users": true}` navega para `/login`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "goes to /login when the server has users"`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "server with users lands on /login"`

**C7a** - Sem rede, health com status ≠ 200, health sem `"status":"healthy"` e info ≠ 200 ou sem `app_name` falham a validação e não salvam nada
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "rejects an unusable server and saves nothing"` (tabela com os 4 casos)

**C7b** - A tela mostra `Could not reach the server` (pt-BR `Não foi possível conectar ao servidor`) quando o motivo é `unreachable`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "shows the unreachable message in en and pt-BR"`

**C7c** - Servidor inalcançável de verdade: mensagem na tela e `config.json` sem `serverUrl`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "unreachable server shows the error and saves nothing"`

**C8a** - Com servidor configurado, o portão renderiza o app sem mostrar a tela de conexão
Proof: `cd frontend && npx vitest run src/components/desktop-gate.test.tsx -t "renders the app when a server is configured"`

**C8b** - Reabrir o app com `config.json` existente chega em `/login` sem a tela de conexão
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "reopening with a saved server skips the connect screen"`

**C9a** - `https://srv.example.com/` é salvo como `https://srv.example.com`
Proof: `cd desktop && npx vitest run src/shared/server-url.test.ts -t "strips the trailing slash"`
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "saves the normalized url after a healthy server"`

**C9b** - `srv.example.com` (e qualquer esquema que não seja http/https) é recusado com `Enter a URL starting with http:// or https://` e nada é salvo
Proof: `cd desktop && npx vitest run src/shared/server-url.test.ts -t "rejects urls without an http or https scheme"`
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "refuses a url without protocol and saves nothing"`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "shows the protocol hint for invalid-url"`

**C9c** - `http://` fora de `localhost`, `127.0.0.1` e `[::1]` mostra um aviso e exige um segundo clique; nos 3 hosts locais não há aviso
Proof: `cd desktop && npx vitest run src/shared/server-url.test.ts -t "classifies http urls by host"`
Proof: `cd desktop && npx vitest run src/main/server-connection.test.ts -t "asks for confirmation on http to a remote host"`
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "warns on insecure http and confirms on the second click"`

**C10a** - `Trocar de servidor` (menu Arquivo) abre a tela de conexão
Proof: `cd desktop && npx vitest run src/main/menu.test.ts -t "File menu has Switch server"`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "switch server opens the connect screen"`

**C10b** - Ao confirmar uma nova URL, `localStorage` perde `token` e `workspace_id` apenas depois da validação, e nenhuma chamada com o token antigo vai ao novo servidor
Proof: `cd frontend && npx vitest run src/pages/connect-server.test.tsx -t "wipes the session only after the new server validates"`
Proof: `cd desktop && npx playwright test e2e/connect.spec.ts -g "switching servers drops the session and never leaks the old token"`

### S3 - Entrar e usar · C11-C15 · 9 arquivos existentes · 89 KB · piso ~22k · estimativa ~89k

**C11a** - Contra o servidor Python (Docker), e-mail e senha levam a `/` e `GET /api/users/me` retorna 200 pelo app
Proof: `cd desktop && LAUNCHKIT_E2E_SERVER_URL=<python> npx playwright test e2e/real-server.spec.ts -g "logs in with password"`

**C11b** - Contra o servidor Python, e-mail, senha e TOTP levam a `/` e `GET /api/users/me` retorna 200 pelo app
Proof: `cd desktop && LAUNCHKIT_E2E_SERVER_URL=<python> npx playwright test e2e/real-server.spec.ts -g "logs in with password and TOTP"`

**C11c** - Contra o servidor Node, os mesmos dois fluxos passam (depende da task 1, ausente desta base: proof pendente)
Proof: `cd desktop && LAUNCHKIT_E2E_SERVER_URL=<node> npx playwright test e2e/real-server.spec.ts` (pendente até a task 1 chegar na base)

**C12** - Uma resposta 401 leva a `app://launchkit/login` e `localStorage.token` fica vazio
Proof: `cd desktop && npx playwright test e2e/session.spec.ts -g "a 401 sends the app to /login and clears the token"`

**C13** - Depois de trocar de workspace, as chamadas saem com `X-Workspace-Id: <id>`
Proof: `cd desktop && npx playwright test e2e/session.spec.ts -g "switching workspace sends X-Workspace-Id"`

**C14a** - As chamadas ao servidor não levam `Origin` nem `Referer` de `app://launchkit`
Proof: `cd desktop && npx vitest run src/main/app-protocol.test.ts -t "drops origin and referer when proxying"`

**C14b** - Um servidor sem CORS para `app://launchkit` (rejeita qualquer `Origin` com 403) responde 200 ao login e a `/users/me`
Proof: `cd desktop && npx playwright test e2e/session.spec.ts -g "a server without CORS answers 200"`

**C15a** - Com `isDesktop`, `/login` não mostra nenhum controle de passkey
Proof: `cd frontend && npx vitest run src/pages/login.test.tsx -t "hides passkey controls when running on desktop"`

**C15b** - Com `isDesktop`, o menu da conta e as configurações da conta não oferecem passkeys
Proof: `cd frontend && npx vitest run src/components/workspace-switcher.test.tsx -t "hides the passkeys entry when running on desktop"`

### S4 - Janela segura · C16-C22 · 0 arquivos existentes (código novo no main) · piso ~0k · estimativa ~30k

**C16** - `webPreferences` da janela tem `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "window web preferences are locked down"`

**C17a** - Clique em `https://example.com` chama `shell.openExternal` com a URL e a janela continua em `app://launchkit/…`
Proof: `cd desktop && npx vitest run src/main/security.test.ts -t "opens https links externally"`
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "external link opens in the system browser"`

**C17b** - `javascript:`, `file:` e `launchkit:` não chamam `openExternal`
Proof: `cd desktop && npx vitest run src/main/security.test.ts -t "never opens javascript, file or launchkit urls"`

**C18** - `will-navigate` e `window.open` para fora de `app://launchkit` são cancelados
Proof: `cd desktop && npx vitest run src/main/security.test.ts -t "blocks navigation away from app://launchkit"`
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "renderer cannot navigate away"`

**C19** - `ipcMain.handle` com `senderFrame.url` fora de `app://launchkit/` rejeita sem executar
Proof: `cd desktop && npx vitest run src/main/ipc.test.ts -t "rejects calls from untrusted frames without running the handler"`

**C20a** - `window.launchkit` expõe exatamente os 8 membros
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "window.launchkit exposes exactly the eight members"`

**C20b** - `window.require` e `window.process` não existem
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "window.require and window.process do not exist"`

**C21** - Respostas de `app://launchkit/` têm `Content-Security-Policy` com `default-src 'self'` e sem `unsafe-eval`
Proof: `cd desktop && npx vitest run src/main/app-protocol.test.ts -t "sends a strict content security policy"`
Proof: `cd desktop && npx playwright test e2e/security.spec.ts -g "app responses carry the content security policy"`

**C22** - `@electron/fuses read` no app empacotado: `RunAsNode` e `EnableNodeCliInspectArguments` desligados; `EnableEmbeddedAsarIntegrityValidation` e `OnlyLoadAppFromAsar` ligados
Proof: `cd desktop && npm run package:dir && npx vitest run scripts/fuses.test.ts -t "packaged app fuses"` (build sem assinatura, macOS local; Linux e Windows no CI)

### S5 - Instalar e atualizar · C23-C29 · 6 arquivos existentes · 36 KB · piso ~9k · estimativa ~45k

**C23a** - `desktop-release.yml` dispara por tag `desktop-v*`, usa matriz `macos-latest`/`windows-latest`/`ubuntu-latest` e publica no repositório de releases configurável
Proof: `cd desktop && npx vitest run scripts/release-workflow.test.ts -t "release workflow shape"`

**C23b** - A configuração do electron-builder declara os alvos `dmg` e `zip` (mac), `nsis` (win), `AppImage` e `deb` (linux), `appId` `com.launchkit.desktop` e `publish` github
Proof: `cd desktop && npx vitest run scripts/builder-config.test.ts -t "builder targets and app id"`

**C23c** - Build real da tag e publicação no GitHub Releases (3 sistemas, repositório de releases real)
Proof: pendente - job `desktop-release` no CI com a tag `desktop-v0.1.0`; ver `Local proof limits`

**C24** - `codesign --verify --deep --strict`, `xcrun stapler validate` e `spctl -a -t exec` aceitam o app macOS publicado
Proof: pendente - exige Developer ID e notarização (Unresolved 1); ver `Local proof limits`

**C25** - `Get-AuthenticodeSignature` do instalador Windows com `Status` `Valid`
Proof: pendente - exige certificado Windows (Unresolved 1); ver `Local proof limits`

**C26a** - Dado um evento de atualização disponível do updater, o banner aparece; ao clicar em instalar chama `installUpdate`
Proof: `cd frontend && npx vitest run src/components/update-available-banner.test.tsx -t "shows the desktop update banner and installs on click"`
Proof: `cd desktop && npx vitest run src/main/updater.test.ts -t "forwards update-downloaded to the renderer"`

**C26b** - Com release N+1 em canal de pré-lançamento, o app reinicia e `app.getVersion()` retorna N+1
Proof: pendente - exige app assinado e repositório de releases de teste; ver `Local proof limits`

**C27** - Sem rede, o app abre normalmente e nenhum diálogo de erro de atualização aparece
Proof: `cd desktop && npx vitest run src/main/updater.test.ts -t "swallows update check errors without dialogs"`
Proof: `cd desktop && npx playwright test e2e/launch.spec.ts -g "opens without network and shows no update error dialog"`

**C28** - Em build sem assinatura, o `autoUpdater` não é iniciado
Proof: `cd desktop && npx vitest run src/main/updater.test.ts -t "does not start the autoUpdater for unsigned builds"`

**C29a** - Com `isDesktop`, o renderer não faz requisição a `api.github.com`
Proof: `cd frontend && npx vitest run src/hooks/use-latest-release.test.tsx -t "does not call api.github.com on desktop"`
Proof: `cd desktop && npx playwright test e2e/session.spec.ts -g "renderer never calls api.github.com"`

**C29b** - No web, `useLatestRelease` continua consultando `api.github.com/repos/<UPDATE_CHECK_REPO>/releases/latest`
Proof: `cd frontend && npx vitest run src/hooks/use-latest-release.test.tsx -t "still queries api.github.com on the web"`

### S6 - Experiência nativa · C30-C34 · 6 arquivos existentes · 72 KB · piso ~18k · estimativa ~71k

**C30a** - O menu tem `File`, `Edit`, `View`, `Window`, `Help` (pt-BR `Arquivo`, `Editar`, `Exibir`, `Janela`, `Ajuda`) com `Trocar de servidor` em Arquivo
Proof: `cd desktop && npx vitest run src/main/menu.test.ts -t "menu top level labels in en and pt-BR"`

**C30b** - `Cmd+K` (macOS) ou `Ctrl+K` abre a command palette na janela do app
Proof: `cd desktop && npx playwright test e2e/native.spec.ts -g "Cmd or Ctrl+K opens the command palette"`

**C31a** - Fechar e reabrir devolve `x`, `y`, `width`, `height` salvos
Proof: `cd desktop && npx vitest run src/main/window-state.test.ts -t "restores saved bounds"`
Proof: `cd desktop && npx playwright test e2e/native.spec.ts -g "window bounds survive a restart"`

**C31b** - Se o monitor salvo não existe mais, abre centralizada com 1280×800 e mínimo 800×600
Proof: `cd desktop && npx vitest run src/main/window-state.test.ts -t "falls back to centered 1280x800 when the display is gone"`

**C32** - No macOS, `titleBarStyle` é `hiddenInset`, o cabeçalho tem `-webkit-app-region: drag` e seus botões e campos têm `no-drag`
Proof: `cd desktop && npx vitest run src/main/window-state.test.ts -t "uses hiddenInset on macOS only"`
Proof: `cd frontend && npx vitest run src/components/app-layout.test.tsx -t "drag region on the header and no-drag on controls"`

**C33a** - Baixar um arquivo abre `dialog.showSaveDialog` com `defaultPath` igual ao nome do arquivo e, ao confirmar, grava os mesmos bytes
Proof: `cd desktop && npx vitest run src/main/downloads.test.ts -t "saves the same bytes at the chosen path"`
Proof: `cd desktop && npx playwright test e2e/native.spec.ts -g "download opens the save dialog and writes the same bytes"`

**C33b** - Ao cancelar o diálogo, nenhum arquivo é gravado
Proof: `cd desktop && npx vitest run src/main/downloads.test.ts -t "writes nothing when the dialog is cancelled"`

**C34** - `en.json` e `pt-BR.json` têm as mesmas chaves, incluindo as da tela de conexão, do menu e do banner
Proof: `cd frontend && npx vitest run src/locales/desktop-keys.test.ts -t "en and pt-BR have identical keys"`

### S7 - Verificação no CI · C35-C38 · 4 arquivos existentes · 20 KB · piso ~5k · estimativa ~29k

**C35** - O job `desktop-checks` executa lint, `tsc`, Vitest do main e do preload e o build sem assinatura, e falha se algum falhar
Proof: `cd desktop && npx vitest run scripts/ci-workflow.test.ts -t "desktop-checks runs lint typecheck vitest and unsigned build"`
Proof: `cd desktop && npm run lint && npm run typecheck && npm test && npm run build` (os mesmos passos, localmente)

**C36a** - O teste Playwright `smoke` abre o app, conecta a um servidor de teste, entra, troca de workspace e envia um arquivo (macOS, local)
Proof: `cd desktop && npx playwright test e2e/smoke.spec.ts -g "connects, signs in, switches workspace and uploads a file"`

**C36b** - O job `desktop-e2e` usa a matriz `macos-latest`/`windows-latest`/`ubuntu-latest`
Proof: `cd desktop && npx vitest run scripts/ci-workflow.test.ts -t "desktop-e2e matrix covers the three systems"`

**C36c** - O teste passa em Windows e Linux
Proof: pendente - job `desktop-e2e` no CI; ver `Local proof limits`

**C37** - `changes.py` marca `run_desktop=true` para `desktop/` ou `frontend/` e `false` para só `backend/`, `charts/` ou `docs/`; `test_changes.py` cobre os dois casos
Proof: `python3 .github/ci/test_changes.py CIChangesTest.test_run_desktop_selection`

**C38a** - O bundle do build web não referencia `window.launchkit` além de `window.launchkit?.isDesktop`
Proof: `cd frontend && npx vite build --outDir ../.checks/tmp-web-dist && node ../desktop/scripts/check-web-bundle.mjs ../.checks/tmp-web-dist`

**C38b** - Os testes do frontend passam sem alteração de comportamento
Proof: `cd frontend && npm test`

## Swept

- validation: C6, C7, C9
- failure modes: C7, C12, C27
- idempotency and retry: C3, C8
- authorization: C12, C19
- concurrency and ordering: C3 (segunda instância); C10b (a sessão só cai depois da validação)
- data lifecycle: C10, C31
- external-dependency failure: C7, C27
- state transitions: C6, C10
- observability: not in scope - o cliente remoto usa o console padrão do Electron; o modo local grava logs (task 4)

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| validation failures of a server (4) | fetch throws · health ≠ 200 · health sem `healthy` · info ≠ 200 ou sem `app_name` - tabela em C7a; inalcançável real em C7c | - |
| URL inputs (7) | `https://srv.example.com/` C9a · `srv.example.com` C9b · `ftp://x` C9b · `http://remote.example` C9c · `http://localhost` C9c · `http://127.0.0.1` C9c · `http://[::1]` C9c | - |
| connect-screen locales (2) | en · pt-BR - título C4a, `Checking…` C6b, erro C7b | texto do aviso `http` e dica de protocolo em pt-BR: só paridade de chaves em C34 (batch 3) |
| screens that must not run before a server exists (2) | `/setup` · `/login` - C4a | - |
| reasons returned by `setServerUrl` (3) | `invalid-url` C9b · `insecure` C9c · `unreachable` C7a/C7b | - |
| renderer-visible `window.launchkit` members (8) | todos em C20a (S4); S2 usa `getServerUrl` e `setServerUrl` em C4b, C6c, C8b | `openExternal`, `onUpdateAvailable`, `installUpdate` até S4/S5 |
| privileged-scheme registration (1 assembly) | `main/index.ts` - C1 e C2b usam a montagem real; C2a usa a fábrica sobre a mesma função | - |
| `-webkit-app-region` header elements (header + 2 botões/campos) | C32 | S6 |
| CI jobs (3: `desktop-checks`, `desktop-e2e`, `desktop-release`) | C35, C36b, C23a | - |
| build targets (5: dmg, zip, nsis, AppImage, deb) | C23b | build real no CI (C23c) |
| OS for E2E (3) | macOS C36a | Windows, Linux C36c |
| passkey surfaces on desktop (3: botão em `/login`, método passkey no 2º fator, menu e diálogo de passkeys) | `/login` C15a · 2º fator C15a · menu C15b | - |

- Claims naming a status code, route or response shape: C2a (200), C6a, C7a, C14b (200, 403), C11a/b (200) - cada um tem proof que cruza a fronteira (Playwright ou servidor real); C2a e C6a/C7a têm também o proof de unidade e C2b/C6c/C7c no nível do app.
- No other check claims more than the single case its proof exercises.

## Local proof limits

Ambiente: macOS arm64, Node 22, Docker. Linux e Windows só no CI. **Não existem** conta Apple Developer, certificado Windows, nem repositório de releases do desktop (Unresolved 1 e 2). Não declaro proof verde onde ele não roda:

- C24, C25 - sem certificados. Entrega: configuração de assinatura e notarização no `electron-builder.yml` e no `desktop-release.yml`, lidos de segredos; builds sem assinatura circulam só para uso interno, com atualização desligada (C28).
- C23c - tag real e GitHub Releases. Entrega: workflow com parse do YAML validado (C23a) e build local sem assinatura (`electron-builder --dir`).
- C26b - o `autoUpdater` do macOS (Squirrel.Mac) exige app assinado e uma release N+1 num repositório de teste. Entrega: C26a prova o caminho do evento até o banner e `installUpdate`.
- C36c - Windows e Linux só no job de CI.
- C11c - servidor Node é da task 1, fora desta base. C11a e C11b passam contra o backend Python em Docker (`t03-*`).
- C1, C22, C23 no nível "app empacotado/instalado": o spec aceita `LAUNCHKIT_E2E_EXECUTABLE` para rodar o mesmo teste contra o `.app` gerado por `package:dir` (batch 3); no batch 1 o proof roda no app não empacotado (`out/`), e essa diferença está registrada aqui.

## Handoff

Fórmula: estimativa = 3 × piso (iteração e saída de teste) + código novo (linhas × 12 tokens) + custo fixo dos proofs (10k, mais 10k quando há servidor real em Docker). O piso é `wc -c` ÷ 4 dos arquivos existentes que a slice lê; arquivos lidos por duas slices contam duas vezes na soma ingênua e uma só quando elas ficam no mesmo batch.

| Slice | Piso | Código novo | Fixo | Estimativa | Acumulado |
| --- | --- | --- | --- | --- | --- |
| S1 | 2k | ~700 linhas, 8k (inclui `package.json`, electron-vite, vitest, playwright) | 10k + 10k de instalação | ~34k | 34k |
| S2 | 22k | ~450 linhas, 5k | 10k | ~81k | 115k |
| S3 | 22k | ~250 linhas, 3k | 20k (Docker + Python) | ~89k | 204k |
| S4 | 0k | ~500 linhas, 6k | 10k | ~30k | - |
| S5 | 9k | ~700 linhas, 8k | 10k | ~45k | - |
| S6 | 18k | ~600 linhas, 7k | 10k | ~71k | - |
| S7 | 5k | ~300 linhas, 4k | 10k | ~29k | - |

Corte (slices inteiras, nunca no meio):

- **Batch 1 = S1 + S2 = ~115k.** Superfície única: processo principal (protocolo, configuração, validação de servidor, menu) e a tela de conexão. S3 elevaria o acumulado a 204k (ou ~178k descontando a leitura repetida de `login.tsx`, `api.ts` e `auth-provider.tsx`), acima de 150k; então o batch para depois de S2.
- **Batch 2 = S3 + S4 = ~119k.** S3 muda a superfície (login, passkeys, workspace, servidor real em Docker); S4 volta ao main para endurecer a janela. S5 elevaria a 164k.
- **Batch 3 = S5 + S6 + S7 = ~145k.** Empacotamento, updater, experiência nativa e CI; a leitura de `app-layout.tsx` é compartilhada entre S5 e S6.
