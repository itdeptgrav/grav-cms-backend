# deploy/metabase-pilot/Makefile — the four verbs this pilot needs.
.PHONY: up down reset verify logs bootstrap

ENV_FILE := .env

$(ENV_FILE):
	@echo "No .env — copy .env.example and fill in three distinct passwords:"; \
	 echo "    cp .env.example .env"; exit 1

up: $(ENV_FILE)          ## start everything and wait for health
	docker compose up -d
	@echo "waiting for Metabase to report healthy (first boot builds its app DB, ~60-90s)..."
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' grav-mb-pilot-metabase 2>/dev/null)" = "healthy" ]; do \
	   printf '.'; sleep 5; done; echo " ready"
	@echo "Metabase: http://localhost:3100   (real Accounting data — see README)"

bootstrap: up            ## idempotent Metabase configuration
	./bootstrap.sh

down:                    ## stop, keep data
	docker compose down

reset:                   ## stop and DESTROY all pilot data
	docker compose down -v
	@echo "The reporting database is now EMPTY. Rebuild it from grav-cms-backend"
	@echo "with ONE command, which runs the five steps in the only order that"
	@echo "works on a fresh database (roles, migrate, roles again, sync, verify):"
	@echo ""
	@echo "    npm run reporting:setup -- --apply"
	@echo ""
	@echo "Why roles twice: V003 grants to metabase_reader, which the roles step"
	@echo "creates; and the roles step grants on views the migrations create."
	@echo "See deploy/metabase-pilot/README.md."

verify:                  ## prove read-only + dataset integrity
	./verify.sh

logs:
	docker compose logs -f --tail=100
