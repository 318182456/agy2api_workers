const clock = () => performance.now();
export async function timed(env, name, action) {
  const start = clock();
  try {
    return await action();
  } finally {
    env.REQUEST_TIMINGS?.push({ name, ms: Math.max(0, clock() - start) });
  }
}
export function attachTimings(response, env, start, path) {
  const total = Math.max(0, clock() - start);
  const stages = (env.REQUEST_TIMINGS || []).filter(
    (row) => /^[a-z_]+$/.test(row.name) && Number.isFinite(row.ms),
  );
  response.headers.set(
    'server-timing',
    [
      ...stages.map((row) => row.name + ';dur=' + row.ms.toFixed(1)),
      'total;dur=' + total.toFixed(1),
    ].join(', '),
  );
  if (total >= 1500)
    console.warn(
      JSON.stringify({
        event: 'admin_slow_request',
        route: path.split('?')[0].replace(/[a-f0-9-]{36}/g, ':id'),
        total_ms: Math.round(total),
        stages: stages.map((row) => ({ name: row.name, ms: Math.round(row.ms) })),
      }),
    );
}
