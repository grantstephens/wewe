# Wewe — React Native (Expo).

.DEFAULT_GOAL := help
.PHONY: help check test typecheck start android signal-server prepare-release

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

prepare-release: ## Write+commit fdroid-version.txt + changelog for TAG=vX.Y.Z CHANGELOG=path/to/notes.txt (does not tag or push)
	@test -n "$(TAG)" || (echo "Usage: make prepare-release TAG=v1.0.1 CHANGELOG=path/to/notes.txt" && exit 1)
	@test -n "$(CHANGELOG)" || (echo "Usage: make prepare-release TAG=v1.0.1 CHANGELOG=path/to/notes.txt" && exit 1)
	@test -f "$(CHANGELOG)" || (echo "$(CHANGELOG): no such file - write the release notes first" && exit 1)
	@eval "$$(tools/compute-version.sh $(TAG))"; \
	printf 'versionName=%s\nversionCode=%s\n' "$$versionName" "$$versionCode" > fdroid-version.txt; \
	cp "$(CHANGELOG)" "fastlane/metadata/android/en-US/changelogs/$$versionCode.txt"
	@cat fdroid-version.txt
	git add fdroid-version.txt fastlane/metadata/android/en-US/changelogs/
	git commit -m "chore: prepare fdroid-version.txt + changelog for $(TAG)"
	@echo
	@echo "Committed. Now create and push the tag:"
	@echo "  git tag $(TAG)"
	@echo "  git push origin main $(TAG)"
