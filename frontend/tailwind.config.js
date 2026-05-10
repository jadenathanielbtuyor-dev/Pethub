/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./pages/**/*.html",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#FF8C42',
        'primary-dark': '#E67E2D',
        'primary-light': '#FFB088',
        accent: '#FFFFFF',
        'dark-bg': '#1A1A1A',
      },
    },
  },
  plugins: [],
}