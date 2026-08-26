// Template: plugin_env_probe
console.log(
  JSON.stringify(
    {
      ok: true,
      plugin: 'plugin_env_probe',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      MY_AGENT_ROOT: process.env.MY_AGENT_ROOT || null,
      CQR_WORKSPACE_ROOT: process.env.CQR_WORKSPACE_ROOT || null,
      CQR_PLUGIN_ID: process.env.CQR_PLUGIN_ID || null,
      CQR_PLUGIN_NAME: process.env.CQR_PLUGIN_NAME || null,
    },
    null,
    2,
  ),
);
