// web/tailwind.config.js
//
// Generated from the blue CarePoint design's own Tailwind settings (colours, corner radii, type
// scale, spacing), so the page matches the design instead of approximating it. Only the font
// family is changed: Inter is served from this site (public/fonts), with system fonts as fallback.
// Build the stylesheet with: npm run build:css

module.exports = {
    content: ['./public/index.html', './public/app.js', './public/staff.js'],
    theme: {
        extend: {
            colors: {
                "primary-fixed": "#d9e2ff",
                "surface-container": "#e8edff",
                "surface-container-low": "#f1f3ff",
                "secondary-container": "#80a7ff",
                "on-primary": "#ffffff",
                "on-surface-variant": "#434652",
                "inverse-surface": "#1d3052",
                "on-primary-fixed": "#001944",
                "primary-container": "#3568c8",
                "tertiary-container": "#656c75",
                "tertiary-fixed": "#dce3ee",
                "on-primary-fixed-variant": "#00429a",
                "on-secondary-fixed": "#001944",
                "secondary": "#305baf",
                "background": "#f9f9ff",
                "surface-container-lowest": "#ffffff",
                "on-tertiary-fixed": "#151c24",
                "surface-container-high": "#e0e8ff",
                "on-background": "#041b3c",
                "primary": "#0f4fae",
                "on-tertiary-fixed-variant": "#404750",
                "error-container": "#ffdad6",
                "outline-variant": "#c3c6d4",
                "secondary-fixed": "#d9e2ff",
                "on-secondary-container": "#003987",
                "surface-bright": "#f9f9ff",
                "on-secondary": "#ffffff",
                "surface-tint": "#235aba",
                "surface-dim": "#cadaff",
                "secondary-fixed-dim": "#afc6ff",
                "on-error-container": "#93000a",
                "on-tertiary-container": "#e7eef9",
                "on-error": "#ffffff",
                "surface": "#f9f9ff",
                "on-secondary-fixed-variant": "#0b4395",
                "tertiary-fixed-dim": "#c0c7d2",
                "outline": "#737784",
                "inverse-primary": "#afc6ff",
                "surface-container-highest": "#d7e2ff",
                "on-primary-container": "#e9edff",
                "primary-fixed-dim": "#afc6ff",
                "inverse-on-surface": "#edf0ff",
                "on-tertiary": "#ffffff",
                "on-surface": "#041b3c",
                "tertiary": "#4d545d",
                "error": "#ba1a1a",
                "surface-variant": "#d7e2ff"
            },
            borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "full": "9999px" },
            fontSize: {
                "title-md": [
                    "16px",
                    {
                        "lineHeight": "24px",
                        "fontWeight": "600"
                    }
                ],
                "display-lg": [
                    "40px",
                    {
                        "lineHeight": "48px",
                        "letterSpacing": "-0.02em",
                        "fontWeight": "700"
                    }
                ],
                "headline-lg": [
                    "32px",
                    {
                        "lineHeight": "40px",
                        "letterSpacing": "-0.015em",
                        "fontWeight": "600"
                    }
                ],
                "headline-sm": [
                    "20px",
                    {
                        "lineHeight": "28px",
                        "fontWeight": "600"
                    }
                ],
                "headline-md": [
                    "24px",
                    {
                        "lineHeight": "32px",
                        "letterSpacing": "-0.01em",
                        "fontWeight": "600"
                    }
                ],
                "body-lg": [
                    "16px",
                    {
                        "lineHeight": "24px",
                        "fontWeight": "400"
                    }
                ],
                "label-md": [
                    "14px",
                    {
                        "lineHeight": "20px",
                        "fontWeight": "500"
                    }
                ],
                "label-sm": [
                    "12px",
                    {
                        "lineHeight": "16px",
                        "letterSpacing": "0.02em",
                        "fontWeight": "600"
                    }
                ],
                "headline-lg-mobile": [
                    "26px",
                    {
                        "lineHeight": "34px",
                        "letterSpacing": "-0.01em",
                        "fontWeight": "600"
                    }
                ],
                "body-sm": [
                    "13px",
                    {
                        "lineHeight": "18px",
                        "fontWeight": "400"
                    }
                ],
                "body-md": [
                    "14px",
                    {
                        "lineHeight": "20px",
                        "fontWeight": "400"
                    }
                ]
            },
            spacing: { "space-lg": "1.5rem", "margin-mobile": "1rem", "space-md": "1rem", "space-sm": "0.5rem", "space-xs": "0.25rem", "gutter-mobile": "1rem", "margin": "2rem", "gutter": "1.5rem", "space-xl": "2.5rem" },
            fontFamily: {
                sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
                mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
            },
        },
    },
    plugins: [],
};