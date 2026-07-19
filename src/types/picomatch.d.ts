declare module "picomatch" {
  function picomatch(
    pattern: string | string[],
    options?: { dot?: boolean; matchBase?: boolean },
  ): (test: string) => boolean
  export = picomatch
}
