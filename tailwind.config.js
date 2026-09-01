/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces run from the deepest chrome (0) to the lightest raised
        // panel (4). Everything in the UI picks a level rather than a hex.
        surface: {
          0: '#0b0d12',
          1: '#11141b',
          2: '#171b24',
          3: '#1e2330',
          4: '#272d3d',
        },
        edge: {
          DEFAULT: '#2b3243',
          strong: '#3b4356',
        },
        ink: {
          DEFAULT: '#e6e9f2',
          dim: '#9aa3b8',
          faint: '#6b7488',
        },
        accent: {
          DEFAULT: '#8b7cf6',
          soft: '#a698f8',
          deep: '#6d5ce0',
        },
        series: {
          1: '#8b7cf6',
          2: '#38bdf8',
          3: '#34d399',
          4: '#fbbf24',
          5: '#fb7185',
          6: '#f472b6',
          7: '#22d3ee',
          8: '#a3e635',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.7)',
        pop: '0 12px 40px -8px rgba(0,0,0,0.75)',
      },
      transitionTimingFunction: {
        snap: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
