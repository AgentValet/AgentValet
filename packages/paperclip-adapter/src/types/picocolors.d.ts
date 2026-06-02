declare module "picocolors" {
  const pc: {
    cyan: (s: string) => string;
    dim: (s: string) => string;
    [key: string]: (s: string) => string;
  };
  export default pc;
}
