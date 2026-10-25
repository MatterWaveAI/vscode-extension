// mocha 12 is an ES module; the extension host requires the CommonJS file
// behind it, which @types/mocha does not name.
declare module "mocha/lib/mocha.cjs" {
  import Mocha from "mocha";
  export = Mocha;
}
