import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        graphite: {
          950: "#14140f",
          900: "#1b1b15",
          800: "#26261d",
          700: "#353426",
        },
        hairline: "#3d3c2e",
        parchment: {
          DEFAULT: "#efe9db",
          dim: "#a6a190",
        },
        bullion: {
          gold: "#c9a24b",
          "gold-dim": "#8a7038",
          silver: "#b7bdc4",
        },
        verified: "#6a8f74",
        alert: "#b3543a",
      },
      fontFamily: {
        display: ["Libre Franklin", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
