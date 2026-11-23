# Psalm101 Chrome Extension — build & release Makefile
#
#   make help          show available targets
#   make fetch-assets  download ONNX model & WASM runtime from GitHub Releases (ASSET_TAG=latest or vX.Y.Z)
#   make check         validate manifest.json, managed_schema.json, JS syntax, and required files
#   make bundle        build Chrome Web Store ZIP (dist/Psalm101-extension-<version>.zip)
#   make unpacked      build ZIP and extract to dist/Psalm101-extension-<version>/ for Load unpacked
#   make bump          set version (e.g. make bump NEW_VERSION=0.3.2)
#   make bump-patch    increment patch version (0.3.1 -> 0.3.2)
#   make bump-minor    increment minor version (0.3.1 -> 0.4.0)
#   make release       verify clean git tree, bundle, push main, tag v<version>, and publish GitHub Release
#                      (supports DRY_RUN=1 and NOTES="Release notes..." or NOTES_FILE=path)
#   make clean         remove dist/

SHELL     := /bin/bash
REPO      := benpbolton/psalm101-extension
EXT       := extension
DIST      := dist
VERSION   := $(shell python3 -c "import json; print(json.load(open('$(EXT)/manifest.json'))['version'])")
TAG       := v$(VERSION)
ASSET_TAG ?= latest
ZIP_NAME  := Psalm101-extension-$(VERSION).zip
ZIP       := $(DIST)/$(ZIP_NAME)
UNPACKED  := $(DIST)/Psalm101-extension-$(VERSION)
STAGE     := $(DIST)/.stage
MODEL     := $(EXT)/models/accurate.fp16.onnx
WASM      := $(EXT)/vendor/ort-wasm-simd-threaded.asyncify.wasm
REQ_ICONS := $(EXT)/icons/16.png $(EXT)/icons/32.png $(EXT)/icons/48.png $(EXT)/icons/128.png

.DEFAULT_GOAL := help
.PHONY: help fetch-assets check bundle unpacked bump bump-patch bump-minor release clean

help:
	@sed -n '3,13p' Makefile | sed 's/^# \{0,1\}//'

fetch-assets:
	@mkdir -p $(EXT)/models $(EXT)/vendor
	@if [ "$(ASSET_TAG)" = "latest" ]; then \
		base="https://github.com/$(REPO)/releases/latest/download"; \
	else \
		base="https://github.com/$(REPO)/releases/download/$(ASSET_TAG)"; \
	fi; \
	echo "downloading model & WASM from $$base ..."; \
	curl -fL "$$base/accurate.fp16.onnx" -o "$(MODEL)" && \
	curl -fL "$$base/ort-wasm-simd-threaded.asyncify.wasm" -o "$(WASM)"
	@echo "ready: $(MODEL) and $(WASM)"

check:
	@python3 -c "import json, re; m=json.load(open('$(EXT)/manifest.json')); assert re.fullmatch(r'\d+\.\d+\.\d+', m['version']), 'invalid version'; assert m['manifest_version']==3; json.load(open('$(EXT)/managed_schema.json'))"
	@for f in $(REQ_ICONS) $(EXT)/THIRD_PARTY_LICENSES.txt $(EXT)/vendor/ort.webgpu.min.mjs $(EXT)/vendor/ort-wasm-simd-threaded.asyncify.mjs; do \
		test -f "$$f" || { echo "ERROR: missing required file $$f"; exit 1; }; \
	done
	@if command -v node >/dev/null 2>&1; then \
		for f in $(EXT)/*.js; do node --check "$$f" || exit 1; done; \
	else \
		echo "note: node not found; skipped JS syntax check"; \
	fi
	@echo "check ok (Psalm101 $(TAG))"

bundle: check $(MODEL) $(WASM)
	@rm -rf $(STAGE) && mkdir -p $(STAGE)
	@rsync -a --exclude .DS_Store --exclude 'models/README.md' --exclude tests --exclude 'config*.js' $(EXT)/ $(STAGE)/
	@rm -f $(ZIP) && cd $(STAGE) && zip -qrX ../$(ZIP_NAME) .
	@rm -rf $(STAGE)
	@unzip -l $(ZIP) | awk '{print $$4}' | grep -qx 'manifest.json' || { echo "ERROR: manifest.json missing at ZIP root"; exit 1; }
	@shasum -a 256 $(ZIP) | awk '{print $$1 "  $(ZIP_NAME)"}' > $(ZIP).sha256
	@echo "built $(ZIP) ($$(du -h $(ZIP) | cut -f1))  sha256: $$(cut -d' ' -f1 $(ZIP).sha256)"

unpacked: bundle
	@rm -rf $(UNPACKED) && mkdir -p $(UNPACKED)
	@unzip -q $(ZIP) -d $(UNPACKED)
	@echo "unpacked: $(UNPACKED)  (load via chrome://extensions -> Load unpacked)"

bump:
	@test -n "$(NEW_VERSION)" || { echo "usage: make bump NEW_VERSION=0.3.2"; exit 1; }
	@python3 -c "import json, re; v='$(NEW_VERSION)'; assert re.fullmatch(r'\d+\.\d+\.\d+', v), 'expected X.Y.Z'; p='$(EXT)/manifest.json'; d=json.load(open(p)); d['version']=v; open(p,'w').write(json.dumps(d,indent=2)+'\n')"
	@if [ -f docs/cws-justifications.md ]; then \
		python3 -c "import re, pathlib; p=pathlib.Path('docs/cws-justifications.md'); p.write_text(re.sub(r'\`v\d+\.\d+\.\d+\`', '\`v$(NEW_VERSION)\`', p.read_text()))"; \
	fi
	@echo "bumped version: $(VERSION) -> $(NEW_VERSION)"

bump-patch:
	@next=$$(python3 -c "a,b,c='$(VERSION)'.split('.'); print(f'{a}.{b}.{int(c)+1}')") && \
		$(MAKE) --no-print-directory bump NEW_VERSION=$$next

bump-minor:
	@next=$$(python3 -c "a,b,c='$(VERSION)'.split('.'); print(f'{a}.{int(b)+1}.0')") && \
		$(MAKE) --no-print-directory bump NEW_VERSION=$$next

release: check bundle
	@command -v gh >/dev/null 2>&1 || { echo "ERROR: GitHub CLI (gh) is required"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "ERROR: working tree is not clean; commit changes before releasing"; git status --short; exit 1; }
	@branch=$$(git rev-parse --abbrev-ref HEAD); test "$$branch" = "main" || { echo "ERROR: releases must be cut from main (currently on $$branch)"; exit 1; }
	@! git rev-parse "$(TAG)" >/dev/null 2>&1 || { echo "ERROR: git tag $(TAG) already exists (run 'make bump-patch' first)"; exit 1; }
	@if [ "$(DRY_RUN)" = "1" ]; then \
		echo "[DRY_RUN] would push main, create tag $(TAG), and publish GitHub Release $(TAG) with:"; \
		echo "  - $(ZIP)"; \
		echo "  - $(ZIP).sha256"; \
		echo "  - $(MODEL)"; \
		echo "  - $(WASM)"; \
	else \
		git push origin main; \
		if [ -n "$(NOTES_FILE)" ]; then \
			gh release create "$(TAG)" "$(ZIP)" "$(ZIP).sha256" "$(MODEL)" "$(WASM)" \
				--repo "$(REPO)" --title "Psalm101 $(TAG)" --notes-file "$(NOTES_FILE)"; \
		elif [ -n "$(NOTES)" ]; then \
			gh release create "$(TAG)" "$(ZIP)" "$(ZIP).sha256" "$(MODEL)" "$(WASM)" \
				--repo "$(REPO)" --title "Psalm101 $(TAG)" --notes "$(NOTES)"; \
		else \
			gh release create "$(TAG)" "$(ZIP)" "$(ZIP).sha256" "$(MODEL)" "$(WASM)" \
				--repo "$(REPO)" --title "Psalm101 $(TAG)" --generate-notes; \
		fi; \
		echo "published https://github.com/$(REPO)/releases/tag/$(TAG)"; \
	fi

clean:
	rm -rf $(DIST)

$(MODEL) $(WASM):
	@echo "missing $@ — run 'make fetch-assets' to download the model & WASM from GitHub Releases"; exit 1
