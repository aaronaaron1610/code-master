/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        vscode: {
          bg: 'var(--vscode-sideBar-background, #1e1e1e)',
          fg: 'var(--vscode-sideBar-foreground, #cccccc)',
          editorBg: 'var(--vscode-editor-background, #1e1e1e)',
          editorFg: 'var(--vscode-editor-foreground, #bbbbbb)',
          inputBg: 'var(--vscode-input-background, #252526)',
          inputFg: 'var(--vscode-input-foreground, #cccccc)',
          inputBorder: 'var(--vscode-input-border, #3c3c3c)',
          buttonBg: 'var(--vscode-button-background, #0e639c)',
          buttonHoverBg: 'var(--vscode-button-hoverBackground, #1177bb)',
          buttonFg: 'var(--vscode-button-foreground, #ffffff)',
          activeBorder: 'var(--vscode-focusBorder, #007fd4)',
          textLink: 'var(--vscode-textLink-foreground, #3794ff)',
          textLinkHover: 'var(--vscode-textLink-activeForeground, #3794ff)',
        }
      },
      animation: {
        'pulse-subtle': 'pulseSubtle 2s infinite ease-in-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      }
    },
  },
  plugins: [],
}
