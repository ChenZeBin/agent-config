# Vendored dependencies

`bashlex` 0.18，来源：https://github.com/idank/bashlex ，固定 tag `0.18` 的 commit `ae1e11a8227d7ca8531b94c7fe821b83bd714ca5`。保留 12 个运行时 Python 源文件，除 `yacc.py` 历史注释仅移除邮箱、保留 Elias Ioup 署名外，与该 commit 对应文件一致；不包含安装器元数据、缓存或未被运行时读取的生成解析表 `parsetab.py`。不修改解析规则。

作者 Idan Kamara；bashlex 按 GPL-3.0-or-later 分发，完整许可证见 `bashlex/LICENSE`。其中 `bashlex/yacc.py` 的 PLY 代码保留 David M. Beazley (Dabeaz LLC) 的版权、BSD-3-Clause 条件及免责声明。所有所需运行时代码以源代码形式随本包提供。
