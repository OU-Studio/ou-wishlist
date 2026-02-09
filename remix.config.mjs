/** @type {import('@remix-run/dev').AppConfig} */
export default {
  serverModuleFormat: "esm",
  publicPath: process.env.PUBLIC_PATH || "/build/",
};
