/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        geist: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        background: '#070A12',
        backgroundSoft: '#0A0F1C',
        surface: '#0E1422',
        surfaceElevated: '#121A2B',
        surfaceHover: '#172033',
        'surface-2': '#121826',
        'surface-3': '#1A2235',
        border: 'rgba(255,255,255,0.08)',
        'border-2': 'rgba(255,255,255,0.12)',

        primary: '#3B82F6',
        secondary: '#8B5CF6',

        emerald: '#22C55E',
        amber: '#F59E0B',
        rose: '#EF4444',

        'text-primary': '#F8FAFC',
        'text-secondary': '#CBD5E1',
        'text-muted': '#94A3B8',
      },
      backgroundImage: {
        'primary-glow': 'radial-gradient(ellipse at top, rgba(59,130,246,0.08) 0%, transparent 60%)',
        'card-gradient': 'linear-gradient(135deg, #0F1420 0%, #121826 100%)',
        'primary-gradient': 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)',
      },
      boxShadow: {
        'primary': '0 0 30px rgba(59,130,246,0.12)',
        'card': '0 1px 3px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.06)',
        'card-hover': '0 4px 24px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(59,130,246,0.15)',
        'glow-blue': '0 0 20px rgba(59,130,246,0.3)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
}
