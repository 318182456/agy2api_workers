export const oauthScript = String.raw`el('oauthStart').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    el('oauthLinkArea').hidden = true;
    const value = await api('/admin/oauth/start', 'POST', {
      mode: el('oauthMode').value,
      name: el('oauthName').value,
      project_id: el('oauthProject').value,
    });
    el('oauthLink').href = value.auth_url;
    el('oauthLinkArea').hidden = false;
    el('callbackUrl').value = '';
    status('授权链接已生成。打开 Google 完成授权，将最后的 localhost 回调 URL 粘贴回来。');
  });
};
el('oauthComplete').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const value = await api('/admin/oauth/complete', 'POST', {
      callback_url: el('callbackUrl').value.trim(),
    });
    el('callbackUrl').value = '';
    el('oauthLinkArea').hidden = true;
    await refresh();
    showPage('credentials');
    loadedPages.add('credentials');
    status(
      'Google 凭证已保存：' +
        value.name +
        (value.user_email ? '，邮箱：' + value.user_email : '') +
        (value.warnings.length ? '\n' + value.warnings.join('；') : ''),
    );
  });
};
`;
