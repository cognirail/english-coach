// 规则零 override：全部来自 @cognirail/eslint-config。
import { defineConfig } from '@cognirail/eslint-config';

export default defineConfig({ tsconfigRootDir: import.meta.dirname });
