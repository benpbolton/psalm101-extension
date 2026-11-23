SHELL   := /bin/bash
REPO    := benpbolton/psalm101-extension
EXT     := extension
DIST    := dist
VERSION := $(shell python3 -c "import json; print(json.load(open('$(EXT)/manifest.json'))['version'])")
ZIP     := $(DIST)/Psalm101-extension-$(VERSION).zip
STAGE   := $(DIST)/.stage
MODEL   := $(EXT)/models/accurate.fp16.onnx
WASM    := $(EXT)/vendor/ort-wasm-simd-threaded.asyncify.wasm

.PHONY: fetch-assets bundle clean

fetch-assets:
	@mkdir -p $(EXT)/models $(EXT)/vendor
	@curl -fL "https://github.com/$(REPO)/releases/download/v$(VERSION)/accurate.fp16.onnx" -o $(MODEL)
	@curl -fL "https://github.com/$(REPO)/releases/download/v$(VERSION)/ort-wasm-simd-threaded.asyncify.wasm" -o $(WASM)
	@echo "downloaded model and ONNX Runtime Web WASM for v$(VERSION)"

bundle: $(MODEL) $(WASM)
	@rm -rf $(STAGE) && mkdir -p $(STAGE)
	@rsync -a --exclude .DS_Store --exclude 'models/README.md' $(EXT)/ $(STAGE)/
	@rm -f $(ZIP) && cd $(STAGE) && zip -qrX ../Psalm101-extension-$(VERSION).zip .
	@rm -rf $(STAGE)
	@echo "built $(ZIP) ($$(du -h $(ZIP) | cut -f1))"

clean:
	rm -rf $(DIST)
