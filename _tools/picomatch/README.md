# Guarded glob matching

This package preserves the MIT-licensed picomatch 4.0.7 distribution with a parser guard for GHSA-fc5q-39xc-vjpf. `upstream.json` records the original file hashes; the contract tests verify that only the declared parser patch differs.

Repeated extglobs containing an unescaped, unquoted wildcard star outside a character class are matched literally unless the parser can flatten them to a safe character class. This prevents an unbounded wildcard from becoming a nested unbounded repetition, including single-branch bodies. The guard also applies when `maxExtglobRecursion` is disabled. Ordinary glob stars, fixed-length extglob repetition, quoted or escaped stars, and stars inside character classes retain their matching behaviour.

The package is installed for every picomatch consumer through the root dependency override. The release checks verify that the lock graph resolves those consumers to this distribution and run bounded subprocess tests for the repeated-wildcard cases.
