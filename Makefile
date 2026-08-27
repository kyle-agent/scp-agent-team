SHELL := /bin/bash
.PHONY: help install dev dev-mock dev-cluster test typecheck contract-test e2e-agui clean

help:
	@echo "make install       - install workspace dependencies"
	@echo "make dev           - mock kagent + adapter + portal (no cluster needed)"
	@echo "make dev-cluster   - adapter + portal against a real kagent (KAGENT_BASE_URL)"
	@echo "make test          - contract + adapter + e2e tests"
	@echo "make typecheck     - typecheck every workspace"
	@echo "make contract-test - validate agent cards and fixtures against the schemas"
	@echo "make e2e-agui      - end-to-end AG-UI run against the mock kagent"

install:
	npm install

dev: dev-mock

dev-mock:
	MOCK_KAGENT=true npx concurrently -k -n mock,adapter,portal -c magenta,cyan,green \
	  "npm run start -w @scp/mock-kagent-a2a" \
	  "sleep 1 && SCP_API_TOKEN=$${SCP_API_TOKEN:-dev-token} MOCK_KAGENT=true AUDIT_FILE=$${AUDIT_FILE:-./audit/agent-access.jsonl} npm run start -w @scp/agui-adapter" \
	  "npm run dev -w @scp/portal"

dev-cluster:
	@test -n "$$KAGENT_BASE_URL" || (echo "KAGENT_BASE_URL is required (e.g. http://127.0.0.1:8083)"; exit 1)
	npx concurrently -k -n adapter,portal -c cyan,green \
	  "SCP_API_TOKEN=$${SCP_API_TOKEN:-dev-token} AUDIT_FILE=$${AUDIT_FILE:-./audit/agent-access.jsonl} npm run start -w @scp/agui-adapter" \
	  "npm run dev -w @scp/portal"

typecheck:
	npm run typecheck --workspaces --if-present

contract-test:
	node --import tsx --test tests/contract/*.test.ts

e2e-agui:
	node --import tsx --test tests/e2e/*.test.ts

test: contract-test e2e-agui
	npm run test --workspaces --if-present

clean:
	rm -rf node_modules */*/node_modules apps/portal/dist audit
