export const credentialsScript = String.raw`let credentialRefreshVersion = 0;
let credentialLiveFlight = Promise.resolve();
async function refresh(options = {}) {
  const version = ++credentialRefreshVersion;
  const value = await api('/admin/credentials?view=basic');
  if (version !== credentialRefreshVersion) return;
  applyCredentialSnapshot(value);
  status('已加载 ' + value.credentials.length + ' 个凭证。');
  if (options.live === false || (currentPage !== 'overview' && currentSection !== 'credentials')) {
    credentialLiveFlight = Promise.resolve();
    el('credentialLiveStatus').textContent = '';
    return;
  }
  el('credentialLiveStatus').textContent = '账号已加载，正在补齐最新健康状态…';
  credentialLiveFlight = (async () => {
    try {
      const live = await api('/admin/credentials/live');
      if (version !== credentialRefreshVersion) return;
      mergeCredentialHealth(value, live);
    } catch {
      if (version === credentialRefreshVersion)
        el('credentialLiveStatus').textContent =
          '最新健康状态暂不可用，当前显示已保存状态；可刷新重试。';
    }
  })();
}
function mergeCredentialHealth(value, live) {
  const health = new Map(live.health.map((row) => [row.credential_id, row]));
  value.credentials = value.credentials.map((row) => {
    const current = health.get(row.id);
    if (!current) return row;
    return {
      ...row,
      last_used: Math.max(row.last_used || 0, current.last_used || 0),
      last_success: Math.max(row.last_success || 0, current.last_success || 0) || null,
      last_failure: Math.max(row.last_failure || 0, current.last_failure || 0) || null,
      last_failure_status:
        (current.last_failure || 0) > (row.last_failure || 0)
          ? current.last_status
          : row.last_failure_status,
    };
  });
  applyCredentialSnapshot(value, !!document.querySelector?.('#credentials .nearby-detail'));
  el('credentialLiveStatus').textContent = '健康状态更新于 ' + formatReset(live.queried_at);
}
function applyCredentialSnapshot(value, preserveRows = false) {
  credentialsSnapshot = value.credentials;
  credentialsLoaded = true;
  renderEndpoints();
  oauthClientModes = value.oauth_clients || {};
  for (const id of selectedCredentials)
    if (!value.credentials.some((c) => c.id === id)) selectedCredentials.delete(id);
  const selectedFilter = el('callsCredential').value;
  el('callsCredential').replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部凭证';
  el('callsCredential').append(all);
  for (const item of value.credentials) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent =
      (item.user_email || item.name) +
      (item.user_email ? ' · ' + item.name : '') +
      ' · ' +
      item.mode;
    el('callsCredential').append(option);
  }
  el('callsCredential').value = value.credentials.some((c) => c.id === selectedFilter)
    ? selectedFilter
    : '';
  if (!preserveRows) renderCredentials();
  for (const target of ['overviewAccounts', 'credentialSummary']) {
    el(target).replaceChildren();
    for (const [label, count, state] of [
      ['全部账号', value.credentials.length, ''],
      ['已启用', value.credentials.filter((c) => !c.disabled).length, 'enabled'],
      ['已停用', value.credentials.filter((c) => c.disabled).length, 'disabled'],
      ['模型冷却中', value.credentials.filter((c) => c.cooling_models).length, 'cooling'],
      [
        '最近异常',
        value.credentials.filter((c) => c.last_failure > (c.last_success || 0)).length,
        'error',
      ],
    ]) {
      const box = document.createElement('a');
      box.className = 'metric';
      bindMetricLink(box, 'credentials', { state, mode: '', search: '' });
      const title = document.createElement('small');
      title.textContent = label;
      const number = document.createElement('strong');
      number.textContent = String(count);
      box.append(title, number);
      el(target).append(box);
    }
  }
}
let credentialPage = 0;
function filteredCredentials() {
  const search = el('credentialSearch').value.trim().toLowerCase(),
    mode = el('credentialMode').value,
    state = el('credentialState').value;
  return credentialsSnapshot.filter(
    (c) =>
      (!search ||
        [c.name, c.user_email, c.project_id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(search)) &&
      (!mode || c.mode === mode) &&
      (!state ||
        (state === 'enabled' && !c.disabled) ||
        (state === 'disabled' && c.disabled) ||
        (state === 'cooling' && c.cooling_models) ||
        (state === 'error' && c.last_failure > (c.last_success || 0))),
  );
}
function visibleCredentials() {
  return filteredCredentials().slice(credentialPage * 25, (credentialPage + 1) * 25);
}
function renderCredentials() {
  const filtered = filteredCredentials();
  credentialPage = Math.min(credentialPage, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  parkNearby('healthPanel');
  el('credentials').replaceChildren();
  el('credentialsEmpty').hidden = filtered.length > 0;
  el('credentialCount').textContent =
    '共 ' + credentialsSnapshot.length + ' 个账号 · 匹配 ' + filtered.length + ' 个';
  el('credentialPageInfo').textContent = filtered.length
    ? '第 ' + (credentialPage + 1) + ' / ' + Math.ceil(filtered.length / 25) + ' 页 · 每页 25 个'
    : '暂无账号';
  el('credentialsPrev').hidden = credentialPage === 0;
  el('credentialsNext').hidden = (credentialPage + 1) * 25 >= filtered.length;
  for (const credential of visibleCredentials()) {
    const tr = document.createElement('tr');
    const localRun = (action) => runNear('credential:' + credential.id, action);
    const selection = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'credential-select';
    checkbox.dataset.id = credential.id;
    checkbox.checked = selectedCredentials.has(credential.id);
    checkbox.setAttribute('aria-label', '选择 ' + (credential.user_email || credential.name));
    checkbox.onchange = () => {
      if (checkbox.checked) selectedCredentials.add(credential.id);
      else selectedCredentials.delete(credential.id);
      updateSelection();
    };
    selection.append(checkbox);
    tr.append(selection);
    const testStatus = credential.last_test
      ? credential.last_test.limited
        ? '；测试限流'
        : credential.last_test.success
          ? '；测试通过'
          : '；测试失败'
      : '';
    const observed =
      credential.last_failure && credential.last_failure > (credential.last_success || 0)
        ? '最近异常（HTTP ' + credential.last_failure_status + '）'
        : credential.last_success
          ? '最近成功'
          : '尚无生成观察';
    const values = [
      (credential.user_email || credential.name) +
        (credential.user_email ? '\n' + credential.name : ''),
      credential.mode,
      (credential.disabled ? '停用' : '启用') +
        ' · ' +
        observed +
        (credential.cooling_models ? '\n' + credential.cooling_models + ' 个模型冷却中' : '') +
        testStatus,
      credential.last_success ? formatReset(credential.last_success) : '—',
    ];
    for (const [index, text] of values.entries()) {
      const td = document.createElement('td');
      td.textContent = text;
      if (index === 0)
        td.title =
          '项目：' +
          (credential.project_id || '待校验') +
          ' · 优先级 ' +
          (credential.priority ?? 0) +
          ' · 权重 ' +
          (credential.weight ?? 1) +
          (credential.subscription_tier ? ' · 等级 ' + credential.subscription_tier : '') +
          (credential.credit_amount != null ? ' · 积分 ' + credential.credit_amount : '');
      tr.append(td);
    }
    const actions = document.createElement('td');
    const menu = document.createElement('details');
    menu.className = 'row-menu';
    const menuTitle = document.createElement('summary');
    menuTitle.textContent = '更多操作';
    menu.append(menuTitle);
    const extraActions = document.createElement('div');
    extraActions.className = 'action-menu';
    menu.append(extraActions);
    const email = document.createElement('button');
    email.className = 'secondary';
    email.textContent = '获取邮箱';
    email.onclick = () =>
      localRun(async () => {
        const result = await api('/admin/credentials/' + credential.id + '/email', 'POST', {});
        await refresh();
        status('邮箱：' + result.user_email);
      });
    const verify = document.createElement('button');
    verify.className = 'secondary';
    verify.textContent = '校验项目';
    verify.onclick = () => localRun(() => verifyCredentialProject(credential));
    if (credential.mode === 'antigravity') {
      const credits = document.createElement('button');
      credits.className = 'secondary';
      credits.textContent = credential.enable_credit ? '关闭此账号 Credits' : '允许此账号 Credits';
      credits.onclick = () =>
        localRun(async () => {
          if (
            !credential.enable_credit &&
            !confirm(
              '允许此账号使用 AI Credits，可能消费付费额度；仍需同时开启设置中的全局 Credits 开关。继续？',
            )
          )
            return;
          await api('/admin/credentials/' + credential.id + '/credits', 'POST', {
            enabled: !credential.enable_credit,
          });
          await refresh();
          status('账号 Credits 授权已更新，仍受全局开关控制。');
        });
      extraActions.append(credits);
    }
    if (credential.mode === 'geminicli') {
      const preview = document.createElement('button');
      preview.className = 'secondary';
      preview.textContent =
        credential.preview_channel === 'EXPERIMENTAL' ? '检查 Preview' : '开通 Preview';
      preview.onclick = () =>
        localRun(async () => {
          if (
            !confirm(
              '将为此凭证对应的 Cloud 项目创建实验通道设置和绑定，需要项目设置管理权限。继续？',
            )
          )
            return;
          const value = await api('/admin/credentials/' + credential.id + '/preview', 'POST', {});
          await refresh();
          status('Preview 实验通道已配置：' + value.project_id);
        });
      extraActions.append(preview);
    }
    const test = document.createElement('button');
    test.className = 'secondary';
    test.textContent = '测试调用';
    test.title = '向指定凭证发起一次 hi 请求，最多生成 1 token，会消耗少量额度';
    test.onclick = () => {
      if (confirm('将使用此凭证发起一次最小聊天请求，消耗少量额度，是否继续？'))
        localRun(async () => {
          const result = await api('/admin/credentials/' + credential.id + '/test', 'POST', {});
          await refresh();
          status(
            result.limited
              ? 'Google 返回 429：当前限流，不能证明本次生成可用。'
              : '指定凭证测试通过，模型：' + result.model,
          );
        });
    };
    const download = document.createElement('button');
    download.className = 'secondary';
    download.textContent = '下载凭证';
    download.onclick = () =>
      localRun(async () => {
        const credentialData = await api('/admin/credentials/' + credential.id + '/download');
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(credentialData, null, 2)], { type: 'application/json' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = credential.name.endsWith('.json')
          ? credential.name
          : credential.name + '.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status('已下载凭证，请妥善保管，其中包含令牌。');
      });
    const rename = document.createElement('button');
    rename.className = 'secondary';
    rename.textContent = '修改名称';
    rename.onclick = () =>
      nearbyEditor(
        tr,
        'credential:' + credential.id,
        6,
        '修改名称',
        [
          {
            name: 'name',
            label: '凭证名称',
            value: credential.name,
            required: true,
            maxLength: 200,
          },
        ],
        async (inputs) => {
          await api('/admin/credentials/' + credential.id, 'PATCH', {
            name: inputs.name.value.trim(),
          });
          await refresh();
          el('callsBody').replaceChildren();
          status('凭证名称已更新。');
        },
      );
    const health = document.createElement('button');
    health.className = 'secondary';
    health.textContent = '健康详情';
    health.onclick = () =>
      localRun(async () => {
        const value = await api('/admin/credentials/' + credential.id + '/health');
        const h = value.health;
        el('healthDetails').textContent = [
          (credential.user_email || credential.name) +
            ' · ' +
            credential.mode +
            (credential.disabled ? ' · 已停用' : ' · 启用'),
          '最后成功：' + (h?.last_success ? formatReset(h.last_success) : '无'),
          '最后失败：' +
            (h?.last_failure
              ? formatReset(h.last_failure) +
                ' · HTTP ' +
                h.last_status +
                ' · ' +
                h.last_stage +
                ' · ' +
                (h.last_code || '未知原因')
              : '无'),
          '失败摘要计数（同类错误按分钟合并）：' + (h?.failure_streak || 0),
          '当前模型冷却：',
          ...value.cooldowns.map(
            (q) => q.model + ' · HTTP ' + q.status + ' · 截止 ' + formatReset(q.until_ms),
          ),
          ...(!value.cooldowns.length ? ['无'] : []),
        ].join('\n');
        mountNearby(
          tr,
          'healthPanel',
          6,
          (credential.user_email || credential.name) + ' · 健康详情',
        );
        el('healthPanel').open = true;
        status('已加载凭证健康详情。');
      });
    const scheduling = document.createElement('button');
    scheduling.className = 'secondary';
    scheduling.textContent = '调度设置';
    scheduling.onclick = () =>
      nearbyEditor(
        tr,
        'credential:' + credential.id,
        6,
        '调度设置',
        [
          {
            name: 'priority',
            label: '优先级（优先级策略使用）',
            type: 'number',
            min: -100,
            max: 100,
            value: credential.priority ?? 0,
            required: true,
          },
          {
            name: 'weight',
            label: '权重（权重随机策略使用）',
            type: 'number',
            min: 1,
            max: 100,
            value: credential.weight ?? 1,
            required: true,
          },
        ],
        async (inputs) => {
          await api('/admin/credentials/' + credential.id, 'PATCH', {
            priority: Number(inputs.priority.value),
            weight: Number(inputs.weight.value),
          });
          await refresh();
          status('调度设置已保存。');
        },
      );
    actions.append(health);
    extraActions.append(rename, scheduling, email, verify, test, download);
    const history = document.createElement('button');
    history.className = 'secondary';
    history.textContent = '问题记录';
    history.onclick = () =>
      localRun(async () => {
        showPage('logs');
        el('callsCredential').value = credential.id;
        await loadCalls();
        loadedPages.add('logs');
        el('callsBody').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    extraActions.append(history);
    if (credential.cooling_models) {
      const clear = document.createElement('button');
      clear.className = 'secondary';
      clear.textContent = '清除冷却';
      clear.onclick = () =>
        localRun(async () => {
          await api('/admin/credentials/' + credential.id + '/cooldowns', 'DELETE');
          await refresh();
          status('已清除该凭证的模型冷却；若 Google 仍限流，再次调用仍可能失败。');
        });
      extraActions.append(clear);
    }
    const toggle = document.createElement('button');
    toggle.textContent = credential.disabled ? '启用' : '停用';
    toggle.className = 'secondary';
    toggle.onclick = () =>
      localRun(async () => {
        await api('/admin/credentials/' + credential.id, 'PATCH', {
          disabled: !credential.disabled,
        });
        await refresh();
      });
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.className = 'danger';
    remove.onclick = () => {
      if (confirm('确认删除凭证 ' + credential.name + '？'))
        localRun(async () => {
          await api('/admin/credentials/' + credential.id, 'DELETE');
          await refresh();
        });
    };
    if (credential.detected_mode && credential.detected_mode !== credential.mode) {
      const repair = document.createElement('button');
      repair.textContent = '纠正为 ' + credential.detected_mode;
      repair.onclick = () => {
        if (
          confirm(
            '将该凭证从 ' +
              credential.mode +
              ' 移至 ' +
              credential.detected_mode +
              '？请同步修改客户端 Base URL。',
          )
        )
          localRun(async () => {
            await api('/admin/credentials/' + credential.id, 'PATCH', {
              mode: credential.detected_mode,
            });
            await refresh();
            status(
              '渠道已纠正。Antigravity 的 OpenAI Base URL 为 ' +
                location.origin +
                '/antigravity/v1',
            );
          });
      };
      extraActions.append(repair);
    }
    if (['antigravity', 'geminicli'].includes(credential.mode)) {
      const quota = document.createElement('button');
      quota.textContent = '查看额度';
      quota.onclick = () => localRun(() => showQuota(credential));
      actions.append(quota);
    }
    extraActions.append(toggle, remove);
    actions.append(menu);
    registerNearby('credential:' + credential.id, actions);
    tr.append(actions);
    el('credentials').append(tr);
    const details = document.createElement('tr');
    details.id = 'quota-' + credential.id;
    details.className = 'quota-details';
    details.hidden = true;
    const cell = document.createElement('td');
    cell.colSpan = 6;
    details.append(cell);
    el('credentials').append(details);
  }
  updateSelection();
  el('batchPanel').open ||= selectedCredentials.size > 0;
}
for (const id of ['credentialSearch', 'credentialMode', 'credentialState'])
  el(id).oninput = el(id).onchange = () => {
    credentialPage = 0;
    renderCredentials();
  };
el('credentialsPrev').onclick = () => {
  if (credentialPage > 0) credentialPage--;
  renderCredentials();
};
el('credentialsNext').onclick = () => {
  if ((credentialPage + 1) * 25 < filteredCredentials().length) credentialPage++;
  renderCredentials();
};
el('clearSelection').onclick = () => {
  selectedCredentials.clear();
  updateSelection();
};
function formatReset(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}
async function verifyCredentialProject(credential, body = {}) {
  const details = el('quota-' + credential.id);
  const hadQuota = details && !details.hidden;
  try {
    const result = await api('/admin/credentials/' + credential.id + '/verify', 'POST', body);
    await refresh();
    status('项目校验成功，已保存：' + result.project_id);
    nearbyMessage('credential:' + credential.id, '项目校验成功，已保存：' + result.project_id);
    if (hadQuota) await showQuota(credential);
  } catch (error) {
    const current = el('quota-' + credential.id);
    if (current) {
      current.hidden = false;
      const cell = current.firstChild;
      cell.textContent = '项目校验未完成：' + error.message;
      if (error.reason === 'PROJECT_REQUIRED') {
        const form = document.createElement('form');
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.id = 'project-id-' + credential.id;
        input.name = 'project_id';
        input.required = true;
        input.pattern = '[a-z][a-z0-9-]{4,28}[a-z0-9]';
        input.maxLength = 30;
        input.placeholder = '例如 my-gemini-project';
        input.value = body.project_id || credential.project_id || '';
        label.htmlFor = input.id;
        label.textContent = 'Google Cloud 项目 ID（不是项目名称或数字编号）';
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = '使用此项目校验';
        const help = document.createElement('a');
        help.href =
          'https://geminicli.com/docs/get-started/authentication/#set-your-google-cloud-project';
        help.target = '_blank';
        help.rel = 'noopener noreferrer';
        help.textContent = '查看 Google 官方项目配置说明';
        const projects = document.createElement('a');
        projects.className = 'button secondary';
        projects.href = 'https://console.cloud.google.com/cloud-resource-manager';
        projects.target = '_blank';
        projects.rel = 'noopener noreferrer';
        projects.textContent = '打开 Google Cloud 项目列表';
        const note = document.createElement('p');
        note.textContent = '使用此凭证对应的 Google 账号登录，复制项目 ID 后填入上方。';
        form.append(label, input, submit, projects, note, help);
        form.onsubmit = (event) => {
          event.preventDefault();
          run(() => verifyCredentialProject(credential, { project_id: input.value.trim() }));
        };
        cell.append(form);
      }
    }
    throw error;
  }
}
async function showQuota(credential, fresh = false) {
  const details = el('quota-' + credential.id);
  const cell = details.firstChild;
  details.hidden = false;
  cell.textContent = '正在查询额度…';
  status('正在查询 ' + credential.name + ' 的 ' + credential.mode + ' 额度…');
  try {
    const value = await api(
      '/admin/credentials/' + credential.id + '/quota' + (fresh ? '?fresh=1' : ''),
    );
    cell.replaceChildren();
    const heading = document.createElement('p');
    heading.textContent =
      '查询时间：' +
      formatReset(value.queriedAt) +
      '（北京时间）' +
      (value.cached ? ' · DO 缓存（最多 10 分钟）' : ' · 本次查询 Google') +
      '。剩余比例由 Google 返回，不等同于剩余调用次数。';
    cell.append(heading);
    const controls = document.createElement('div');
    const reload = document.createElement('button');
    reload.textContent = '重新查询 Google';
    reload.onclick = () => run(() => showQuota(credential, true));
    const hide = document.createElement('button');
    hide.className = 'secondary';
    hide.textContent = '收起';
    hide.onclick = () => {
      details.hidden = true;
    };
    controls.append(reload, hide);
    cell.append(controls);
    if (!value.models.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Google 未返回模型信息，无法确定额度。';
      cell.append(empty);
    } else {
      renderSingleQuota(cell, value.models, credential.mode);
    }
    status('已更新 ' + credential.name + ' 的额度。');
  } catch (error) {
    cell.textContent = '查询失败：' + error.message;
    throw error;
  }
}
`;
