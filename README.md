<p align="center">
  <img src="frontend/public/favicon.svg" width="96" alt="launchkit logo" />
</p>
<h1 align="center">launchkit</h1>

<p align="center">
A self-hosted full-stack starter: FastAPI + PostgreSQL + Celery on the back, React + Tailwind + shadcn on the front, with authentication, workspaces, an admin panel and a component library already done.
</p>

## What's in the box

- **Auth:** email and password, first-run admin setup, TOTP two-factor, passkeys (WebAuthn), OIDC/SSO (Authentik, Pocket ID, …) with optional role sync, rate-limited login, and public registration that admins can switch off.
- **Workspaces:** every user gets a personal workspace. Additional workspaces have members with owner, editor and viewer roles, plus an optional external manager. Every request is scoped by the `X-Workspace-Id` header.
- **Admin panel:** user CRUD, registration toggle, brand colours, number and date formats, and the application timezone.
- **Files:** workspace-scoped uploads on a pluggable storage provider (local disk out of the box), with size and type limits.
- **Background jobs:** a Celery worker and beat on Redis, with an example task and schedule.
- **UI kit:** shadcn/Radix primitives, a light and a dark theme, a collapsible sidebar, a ⌘K command palette, privacy mode, i18n (en, pt-BR), and a chart library (area, line, bar, composed, donut, sankey, sparkline, stat tile) on a colour-blind-validated palette.
- **Component catalogue:** `/components` renders every component and chart with sample data.
- **Ops:** Docker Compose for development and production, a Helm chart, a curl-pipe installer, a Cloudflare Tunnel self-hosting guide (`deploy/public`), and CI (ruff, ty, pytest, eslint, tsc, vitest, helm lint).

## Quick start

```bash
cp .env.example .env            # set SECRET_KEY
docker compose up --build
```

Open <http://localhost:3000>. The first visit runs the setup screen, which creates the admin account.

Without Docker:

```bash
# backend (Python 3.11+, PostgreSQL and Redis running locally)
cd backend && uv sync --all-extras
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/launchkit uv run alembic upgrade head
uv run uvicorn app.main:app --reload

# frontend
cd frontend && npm install && npm run dev
```


## Project structure

```
backend/
  app/
    api/          FastAPI routers (auth, setup, admin, workspaces, files, …)
    core/         settings, database, auth, rate limit, workspace context, timezone
    models/       SQLAlchemy models (user, passkey, workspace, app setting, file)
    schemas/      Pydantic request/response models
    services/     business logic called by the routers
    providers/    pluggable adapters (file storage)
    tasks/        Celery tasks (example_tasks.py)
  alembic/        migrations (001 is the whole platform schema)
  tests/          pytest suite (SQLite in memory; PostgreSQL when POSTGRES_TEST_URL is set)
frontend/         React app (see frontend/README.md)
charts/launchkit/ Helm chart
deploy/public/    self-hosting guide, release script, backups (Portuguese)
scripts/          dev helpers
```

## Adding a feature

1. **Model:** add `backend/app/models/<thing>.py` with a `workspace_id` foreign key, then export it from `models/__init__.py`.
2. **Migration:** `cd backend && uv run alembic revision --autogenerate -m "add thing"`, then review the generated file.
3. **API:** add a schema in `schemas/`, a service in `services/`, and a router in `api/`. Depend on `current_workspace` for reads and `current_writable_workspace` for writes. Mount the router in `app/main.py`.
4. **Tests:** see `backend/tests/test_write_permission_gate.py` for the viewer, editor and owner pattern.
5. **UI:** add a page, a route, a nav item and translations (see `frontend/README.md`).

`app/api/files.py` and `pages/files.tsx` are a complete, small example of every layer.

## Configuration

Everything is read from environment variables (`backend/app/core/config.py`); `.env.example` lists the common ones. `GET /api/info` exposes feature flags (`app/core/feature_flags.py`) that the frontend can use to hide optional modules.

## License

AGPL-3.0. launchkit is derived from [Securo](https://github.com/securo-finance/securo), which is AGPL-3.0 licensed, so projects built from this template inherit the same license obligations. See `LICENSE`.
