# Wewe — React Native (Expo).

.DEFAULT_GOAL := help
.PHONY: help check test typecheck start android signal-server

help: ## Show this help
	@echo 'Wewe — targets:'
	@grep -hE '^[a-zA-Z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

check: ## tsc --noEmit && jest — the gate before any commit
	npm run check

test: ## Run the Jest suite
	npm test

typecheck: ## tsc --noEmit only
	npm run typecheck

start: ## Expo dev server; scan the QR code with a dev client (not Expo Go — react-native-webrtc needs native code)
	npm start

android: ## Expo dev server, opening on a connected device
	npm run android

signal-server: ## Run the local signaling relay for development
	npm --prefix signal-server run dev
