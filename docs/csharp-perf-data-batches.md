# 测量批次索引（自动生成）

由 perf/data/build-batch-index.ps1 从各批次 summary.json 的元数据生成。sideA = harness manifest 侧（通常为 C#），sideB = --go-executable 侧（Go 或另一个 C# 构建）。

| 批次 | 日期 | sideA 包 | sideA SHA256 | sideA 节点 | sideB 包 | sideB SHA256 | sideB 节点 | 样本 | 负载数 | 噪声% | ServerGC | 关键比值 |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| AB1-go-isa | 2026-10-06 | local-go-v3 | `` |  |  | `` |  | 15 | 5 | 128.6 | False | medium=1.00 tiny-files=0.99 huge-file=1.01 |
| AB10-emit-proto-vs-upstream | 2026-10-06 | local-naot-emit-proto | `` |  |  | `` |  | 11 | 6 | 61.6 | True | medium=0.68 tiny-files=0.69 huge-file=1.01 |
| AB11-emitproto-vs-go | 2026-10-06 | local-naot-emit-proto | `2c17066a763e` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 6 | 6.1 | True | medium=2.09 tiny-files=1.28 huge-file=3.63 |
| AB12-emit-serial-vs-parallel | 2026-10-06 | local-naot-emit-proto | `` |  |  | `` |  | 11 | 6 | 14.5 | True | medium=0.65 tiny-files=0.70 huge-file=0.99 |
| AB13-conserve-memory | 2026-10-06 | local-naot-wks | `` |  |  | `` |  | 11 | 4 | 13.8 | False | medium=1.04 tiny-files=1.01 huge-file=1.16 |
| AB14-loh-threshold | 2026-10-06 | local-naot-wks | `` |  |  | `` |  | 11 | 4 | 5.4 | False | medium=0.99 tiny-files=1.04 huge-file=0.97 |
| AB15-gen0-size | 2026-10-06 | local-naot-wks | `` |  |  | `` |  | 11 | 4 | 4.4 | False | medium=1.01 tiny-files=1.00 huge-file=0.95 |
| AB16-memory-combo | 2026-10-06 | local-naot-wks | `` |  |  | `` |  | 11 | 4 | 5.9 | False | medium=1.00 tiny-files=1.01 huge-file=1.15 |
| AB17-server-heapcount | 2026-10-06 | local-naot-svr | `` |  |  | `` |  | 11 | 4 | 43.9 | True | medium=0.91 tiny-files=1.03 huge-file=0.99 |
| AB18-recommended-gc | 2026-10-06 | local-naot-wks | `` |  |  | `` |  | 11 | 4 | 9.8 | False | medium=0.99 tiny-files=1.01 huge-file=0.93 |
| AB19-p0-vs-go | 2026-10-06 | local-p0-candidate | `7dbadd5c5436` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 9.8 | False | medium=2.10 tiny-files=1.33 huge-file=3.86 |
| AB2-cs-isa | 2026-10-06 | local-naot-svr-native | `` |  |  | `` |  | 15 | 5 | 17.5 | True | medium=1.00 tiny-files=0.97 huge-file=0.97 |
| AB20-opt1-vs-p0 | 2026-10-06 | local-opt1 | `` |  |  | `` |  | 11 | 7 | 55.6 | False | medium=0.90 tiny-files=1.00 huge-file=1.00 |
| AB21-embed-effect | 2026-10-06 | local-opt1 | `` |  |  | `` |  | 11 | 7 | 22.3 | False | medium=1.00 tiny-files=1.02 huge-file=0.98 |
| AB22-opt1-vs-go | 2026-10-06 | local-opt1 | `839d11b9a925` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 24.3 | False | medium=1.85 tiny-files=1.32 huge-file=3.86 |
| AB23-final-vs-go | 2026-10-06 | local-final | `0f3c8cf7bb88` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 20.2 | False | medium=2.04 tiny-files=1.29 huge-file=3.74 |
| AB24-final2-vs-go | 2026-10-07 | local-final2 | `d2802c1ac105` | 6ed638d3a5 + r02a | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 19 | False | medium=1.96 tiny-files=1.32 huge-file=3.59 |
| AB25-final3-vs-go | 2026-10-07 | local-final3 | `68246b1d508d` | 6ed638d3a5 + r02b | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 30.3 | False | medium=1.90 tiny-files=1.29 huge-file=3.51 |
| AB26-final4-vs-go | 2026-10-07 | local-final4 | `5079c5414fa0` | 6ed638d3a5 + r02c | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 5.4 | False | medium=1.92 tiny-files=1.28 huge-file=3.24 |
| AB27-final5-vs-go | 2026-10-08 | local-final5 | `bb1252543c87` | 6ed638d3a5 + r02d | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 20.8 | False | medium=1.84 tiny-files=1.28 huge-file=3.20 |
| AB28-final6-vs-go | 2026-10-08 | local-final6 | `8a3a4475ca57` | 6ed638d3a5 + r02e | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 10 | False | medium=1.83 tiny-files=1.26 huge-file=3.23 |
| AB29-final7-vs-final6 | 2026-10-08 | local-final7 | `666faab8a3f2` | c929d92b44 (embed shape) | final6 | `8a3a4475ca57` | 6ed638d3a5 + r02e | 15 | 23 | 12.3 | False | medium=0.99 tiny-files=1.01 huge-file=0.99 |
| AB3-cs-gc-mode | 2026-10-06 | local-naot-svr | `` |  |  | `` |  | 15 | 4 | 8 | False | medium=1.07 tiny-files=1.05 huge-file=0.93 |
| AB30-go-gogc400-vs-default | 2026-10-08 | go-v1-baseline | `5e46cd5d1518` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 9 | 4 | 8.1 | False | medium=0.91 tiny-files=0.99 huge-file=0.98 |
| AB31-go-embed-vs-noembed | 2026-10-08 | go-embed | `fa62a8ec28a6` | c929d92b44 (Go, embedded libs) | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 7 | 4 | 4.5 | False | medium=1.16 tiny-files=1.08 huge-file=1.05 |
| AB32-go-gogc800-vs-400 | 2026-10-08 | go-v1-baseline | `5e46cd5d1518` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 7 | 3 | 3.1 | False | medium=1.03 huge-file=0.98 |
| AB33-final7-vs-go-gogc400 | 2026-10-08 | local-final7 | `666faab8a3f2` | c929d92b44 (embed shape) | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 15 | 23 | 4.9 | False | medium=1.94 tiny-files=1.36 huge-file=3.11 |
| AB34-final7-vs-baseline-cs | 2026-10-08 | local-final7 | `666faab8a3f2` | c929d92b44 (embed shape) | naot-svr | `13e2fb1f876e` | 6ed638d3a5 | 15 | 23 | 7.2 | False | medium=0.59 tiny-files=0.68 huge-file=0.81 |
| AB35-final7-code-only-vs-baseline | 2026-10-08 | local-final7 | `666faab8a3f2` | c929d92b44 (embed shape) | naot-svr | `13e2fb1f876e` | 6ed638d3a5 | 9 | 10 | 4.7 | False | medium=0.62 huge-file=0.89 |
| AB36-noembed-vs-embed | 2026-10-08 | local-final7-noembed | `0013a021b94d` | c929d92b44 (product shape) | final7 | `666faab8a3f2` | c929d92b44 (embed shape) | 11 | 10 | 17.6 | False | medium=0.96 huge-file=0.98 |
| AB37-final7-noembed-vs-baseline | 2026-10-08 | local-final7-noembed | `0013a021b94d` | c929d92b44 (product shape) | naot-svr | `13e2fb1f876e` | 6ed638d3a5 | 15 | 23 | 10.6 | False | medium=0.59 tiny-files=0.67 huge-file=0.81 |
| AB38-gen0-1MiB-vs-4MiB | 2026-10-08 | local-final7-noembed | `0013a021b94d` | c929d92b44 (product shape) | final7-noembed | `0013a021b94d` | c929d92b44 (product shape) | 11 | 7 | 16.5 | False | medium=1.02 huge-file=1.02 |
| AB4-coreclr-r2r | 2026-10-06 | local-r2r | `` |  |  | `` |  | 11 | 5 | 5.8 | False | medium=0.52 tiny-files=0.62 huge-file=0.82 |
| AB5-coreclr-tiering | 2026-10-06 | local-build-coreclr-sdk-11.0.100-rc.1 | `` |  |  | `` |  | 11 | 4 | 41.1 | False | medium=1.30 tiny-files=1.44 huge-file=0.74 |
| AB6-parse-concurrency | 2026-10-06 | local-patched-parse-concurrency | `` |  |  | `` |  | 15 | 6 | 29.3 | True | medium=1.02 tiny-files=1.00 huge-file=1.01 |
| AB7-parse-auto | 2026-10-06 | local-patched-parse-concurrency | `` |  |  | `` |  | 15 | 6 | 29.5 | True | medium=0.99 tiny-files=0.99 huge-file=1.00 |
| AB8-identical-control | 2026-10-06 | local-go-v1 | `` |  |  | `` |  | 11 | 5 | 11.9 | False | medium=1.00 tiny-files=0.98 huge-file=1.01 |
| AB9-parse-patch-e2e | 2026-10-06 | local-patched-parse-concurrency | `` |  |  | `` |  | 11 | 5 | 25.6 | True | medium=1.01 tiny-files=0.99 huge-file=1.00 |
| pilot-coreclr | 2026-10-06 | local-build-coreclr-sdk-11.0.100-rc.1 | `32693664ed56` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 5 | 3 | 79.6 | False | medium=15.71 |
| proto-emit | 2026-10-06 | local-emit-proto | `32693664ed56` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 5 | 2 | 4.3 | True | medium=11.43 tiny-files=4.27 |
| R1-go-v1-vs-naot-svr | 2026-10-06 | local-naot-svr | `13e2fb1f876e` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 21 | 23 | 8.9 | True | medium=3.14 tiny-files=1.81 huge-file=3.61 |
| R2-go-v1-vs-naot-wks | 2026-10-06 | local-naot-wks | `e6e1e0abe3b8` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 21 | 23 | 19.6 | False | medium=3.02 tiny-files=1.77 huge-file=3.83 |
| R3-go-v3-vs-naot-svr-native | 2026-10-06 | local-naot-svr-native | `f574b205bfa9` | 6ed638d3a5 | go-v3 | `f2dbd3dbf8c2` | 6ed638d3a5 (Go) | 21 | 23 | 16.6 | True | medium=3.11 tiny-files=1.68 huge-file=3.48 |
| R4-go-v1-vs-r2r | 2026-10-06 | local-r2r | `32693664ed56` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 11 | 10 | 16.9 | False | medium=8.27 tiny-files=3.11 huge-file=8.09 |
| R5-go-v1-vs-coreclr | 2026-10-06 | local-build-coreclr-sdk-11.0.100-rc.1 | `32693664ed56` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 11 | 10 | 30.9 | False | medium=15.39 tiny-files=5.17 huge-file=10.30 |
| R6-control-go-vs-go | 2026-10-06 | local-naot-svr | `13e2fb1f876e` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 11 | 4 | 25.3 | False | medium=2.99 tiny-files=1.93 huge-file=3.79 |
| smoke-opt1 | 2026-10-06 | local-opt1 | `839d11b9a925` | 6ed638d3a5 | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 5 | 4 | 44 | False | medium=1.87 tiny-files=1.16 huge-file=3.96 |
| smoke-partshrink | 2026-10-07 | local-probe3 | `32693664ed56` |  | go-v1 | `5e46cd5d1518` | 6ed638d3a5 (Go) | 5 | 6 | 3.4 | False | medium=11.14 tiny-files=4.12 huge-file=10.04 |
