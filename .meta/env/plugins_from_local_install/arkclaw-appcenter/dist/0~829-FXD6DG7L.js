import { createRequire as _createRequire } from 'module';
const require = _createRequire(import.meta.url);
import {
  Client,
  Command,
  buildRequestConfigFromMetaPath,
  init_esm_shims
} from "./chunk-RSFOX6BL.js";

// node_modules/@volcengine/sdk-core/dist/esm/0~829.mjs
init_esm_shims();
function _define_property(obj, key, value) {
  if (key in obj) Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
  else obj[key] = value;
  return obj;
}
var STSClient = class extends Client {
  constructor(config = {}) {
    super({
      protocol: "https",
      region: "cn-beijing",
      ...config
    });
  }
};
var AssumeRoleCommand = class _AssumeRoleCommand extends Command {
  constructor(input) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(_AssumeRoleCommand.metaPath);
  }
};
_define_property(AssumeRoleCommand, "metaPath", "/AssumeRole/2018-01-01/sts/get/text_plain/");
export {
  AssumeRoleCommand,
  STSClient
};
//# sourceMappingURL=0~829-FXD6DG7L.js.map