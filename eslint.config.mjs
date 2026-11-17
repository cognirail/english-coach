// 规则零 override：全部来自 @cognirail/eslint-config。
// ui/pages 是浏览器脚本，预设只有 Node 环境（无 DOM 全局），整目录不进 lint，只过 prettier；
// shortcut: 预设加上浏览器环境后删掉这行 ignores。
import { defineConfig } from '@cognirail/eslint-config';

export default defineConfig({ tsconfigRootDir: import.meta.dirname, ignores: ['ui/pages/**'] });
