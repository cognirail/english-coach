// 设置页：纠错开关、后台进程状态与重启、key 在哪找到、连通测试、模型通道配置。不收也不显示 key。
import { api, el, renderNav, showFatal } from './app.js';

renderNav('/settings');

const FIELDS = ['provider', 'model', 'baseUrl', 'keychainService', 'keychainAccount', 'envKey'];
const $ = (id) => document.getElementById(id);

function setResult(id, text, cls) {
  const node = $(id);
  node.textContent = text;
  node.className = cls ?? 'muted';
}

function render(view) {
  $('enabled').textContent = view.enabled ? '开' : '关（发英文 prompt 不会纠错）';
  $('enabled').className = view.enabled ? 'ok' : 'warn';
  $('toggle-enabled').textContent = view.enabled ? '临时关闭' : '打开';

  $('daemon').textContent =
    view.daemonPid === null
      ? '没在跑（下一条英文 prompt 会自动拉起）'
      : `运行中 · pid ${view.daemonPid}`;
  $('daemon').className = view.daemonPid === null ? 'warn' : 'ok';

  const key = $('key');
  key.replaceChildren();
  if (view.error) {
    key.append(el('span', 'warn', `配置有误：${view.error}`));
  } else if (view.keySource) {
    key.append(
      el(
        'span',
        'ok',
        view.keySource === 'keychain'
          ? `已在 Keychain 找到（${view.resolved.keychainService} / ${view.resolved.keychainAccount}）`
          : `已从环境变量 ${view.resolved.envKey} 读到`,
      ),
    );
  } else {
    const r = view.resolved;
    key.append(
      el('div', 'warn', '没找到 key。在终端运行下面这行，按提示粘贴 key：'),
      el(
        'code',
        null,
        `security add-generic-password -s ${r.keychainService} -a ${r.keychainAccount} -w`,
      ),
    );
  }

  // 输入框只回填 config.json 里显式写了的值；留空的显示生效中的默认值作占位
  for (const field of FIELDS) {
    const input = $(field);
    const own = view.file[field];
    if (field === 'provider') {
      input.value = typeof own === 'string' ? own : (view.resolved?.provider ?? 'anthropic');
      continue;
    }
    input.value = typeof own === 'string' ? own : '';
    input.placeholder = view.resolved ? String(view.resolved[field] || '') : '';
  }
}

async function run(button, resultId, action) {
  button.disabled = true;
  setResult(resultId, '处理中…');
  try {
    await action();
  } catch (error) {
    setResult(resultId, error.message, 'warn');
  } finally {
    button.disabled = false;
  }
}

try {
  let view = await api('/api/settings');
  render(view);

  $('toggle-enabled').addEventListener('click', async () => {
    view = await api('/api/enabled', { method: 'PUT', body: { enabled: !view.enabled } });
    render(view);
  });

  $('restart').addEventListener('click', () =>
    run($('restart'), 'daemon', async () => {
      view = await api('/api/daemon/restart', { method: 'POST' });
      render(view);
    }),
  );

  $('test').addEventListener('click', () =>
    run($('test'), 'test-result', async () => {
      const r = await api('/api/test', { method: 'POST' });
      if (r.ok) setResult('test-result', `通了，${r.ms} ms：${r.sample}`, 'ok');
      else setResult('test-result', `失败（${r.ms} ms）：${r.error}`, 'warn');
    }),
  );

  // provider 切换后，旧通道的默认值占位不再适用：清掉占位，保存后按新通道重新显示
  $('provider').addEventListener('change', () => {
    for (const field of FIELDS.slice(1)) $(field).placeholder = '';
  });

  $('save').addEventListener('click', () =>
    run($('save'), 'save-result', async () => {
      const body = Object.fromEntries(FIELDS.map((f) => [f, $(f).value]));
      view = await api('/api/settings', { method: 'PUT', body });
      render(view);
      setResult('save-result', '已保存，后台进程已用新配置重启', 'ok');
    }),
  );
} catch (error) {
  showFatal(error);
}
