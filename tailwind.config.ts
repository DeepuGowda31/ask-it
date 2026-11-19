import type { Config } from 'tailwindcss';

// Colors come from CSS variables in app/globals.css (dark only).
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        'muted-foreground': 'var(--muted-foreground)',
        border: 'var(--hairline)',
        accent: 'var(--accent)',
        danger: 'var(--danger)',
      },
      fontFamily: { sans: ['var(--font-sans)'], mono: ['var(--font-mono)'] },
    },
  },
  plugins: [],
};
export default config;
