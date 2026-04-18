/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: [
          'var(--font-inter)',
          'SF Pro Display',
          '-apple-system',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SF Mono',
          'Menlo',
          'monospace',
        ],
      },
      fontWeight: {
        light: '300',
        normal: '400',
        emphasis: '510',
        medium: '510',
        strong: '590',
        semibold: '590',
      },
      fontSize: {
        // size, lineHeight, letterSpacing per design doc §3
        'display-xl': ['4.5rem',  { lineHeight: '1',    letterSpacing: '-0.022em', fontWeight: '510' }],
        'display-lg': ['4rem',    { lineHeight: '1',    letterSpacing: '-0.022em', fontWeight: '510' }],
        'display':    ['3rem',    { lineHeight: '1',    letterSpacing: '-0.022em', fontWeight: '510' }],
        'h1':         ['2rem',    { lineHeight: '1.13', letterSpacing: '-0.022em', fontWeight: '400' }],
        'h2':         ['1.5rem',  { lineHeight: '1.33', letterSpacing: '-0.012em', fontWeight: '400' }],
        'h3':         ['1.25rem', { lineHeight: '1.33', letterSpacing: '-0.012em', fontWeight: '590' }],
        'body-lg':    ['1.125rem',{ lineHeight: '1.6',  letterSpacing: '-0.009em', fontWeight: '400' }],
        'body':       ['1rem',    { lineHeight: '1.5',  letterSpacing: '0',        fontWeight: '400' }],
        'small':      ['0.9375rem', { lineHeight: '1.6',  letterSpacing: '-0.011em', fontWeight: '400' }],
        'caption':    ['0.8125rem', { lineHeight: '1.5',  letterSpacing: '-0.01em',  fontWeight: '400' }],
        'label':      ['0.75rem', { lineHeight: '1.4',  letterSpacing: '0',        fontWeight: '510' }],
        'micro':      ['0.6875rem',{ lineHeight: '1.4',  letterSpacing: '0',        fontWeight: '510' }],
        'tiny':       ['0.625rem',{ lineHeight: '1.5',  letterSpacing: '-0.015em', fontWeight: '510' }],
      },
      letterSpacing: {
        'display': '-0.022em',
        'h1':      '-0.022em',
        'h2':      '-0.012em',
        'h3':      '-0.012em',
        'body':    '0',
        'small':   '-0.011em',
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // Linear semantic tokens exposed to Tailwind
        surface: {
          0: 'rgb(var(--surface-0) / <alpha-value>)',
          1: 'rgb(var(--surface-1) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
          3: 'rgb(var(--surface-3) / <alpha-value>)',
          inverse: 'rgb(var(--surface-inverse) / <alpha-value>)',
        },
        overlay: 'rgb(var(--overlay) / <alpha-value>)',
        text: {
          primary:    'rgb(var(--text-primary) / <alpha-value>)',
          secondary:  'rgb(var(--text-secondary) / <alpha-value>)',
          tertiary:   'rgb(var(--text-tertiary) / <alpha-value>)',
          quaternary: 'rgb(var(--text-quaternary) / <alpha-value>)',
          inverse:    'rgb(var(--text-on-brand) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover:   'rgb(var(--brand-hover) / <alpha-value>)',
          active:  'rgb(var(--brand-active) / <alpha-value>)',
          soft:    'rgb(var(--brand-soft) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          soft:    'rgb(var(--success-soft) / <alpha-value>)',
        },
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger:  'rgb(var(--danger) / <alpha-value>)',
        info:    'rgb(var(--info) / <alpha-value>)',
      },
      borderRadius: {
        micro: '2px',
        sm: '4px',
        md: '6px',
        DEFAULT: '6px',
        lg: '8px',
        xl: '12px',
        '2xl': '22px',
      },
      spacing: {
        '4.5': '1.125rem',  // 18px
        '7.5': '1.875rem',  // 30px
        '11':  '2.75rem',   // 44px optical spacing
      },
      boxShadow: {
        'linear-sm':  '0 1px 2px rgb(8 9 10 / 0.04), 0 1px 1px rgb(8 9 10 / 0.03)',
        'linear':     '0 2px 4px rgb(8 9 10 / 0.04), 0 1px 2px rgb(8 9 10 / 0.03), 0 0 0 1px rgb(8 9 10 / 0.04)',
        'linear-lg':  '0 8px 24px rgb(8 9 10 / 0.08), 0 2px 6px rgb(8 9 10 / 0.04), 0 0 0 1px rgb(8 9 10 / 0.06)',
        'popover':    '0 0 0 1px rgb(8 9 10 / 0.06), 0 2px 4px rgb(8 9 10 / 0.04), 0 8px 24px rgb(8 9 10 / 0.10)',
        'focus-brand':'0 0 0 3px rgb(94 106 210 / 0.18)',
        'inset-subtle':'inset 0 0 0 1px rgb(8 9 10 / 0.06)',
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up":   "accordion-up 0.2s ease-out",
        "fade-in":        "fade-in 0.15s ease-out",
        "slide-up":       "slide-up 0.18s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
