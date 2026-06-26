# Ionic Angular Project Structure

Standard directory layout and key files for an Ionic Angular application.

## Directory Layout

### Standalone Architecture (Angular 17+)

```
my-app/
├── android/                          # Android native project (if added)
├── ios/                              # iOS native project (if added)
├── src/
│   ├── app/
│   │   ├── app.component.ts          # Root component
│   │   ├── app.component.html        # Root template (contains <ion-app> and <ion-router-outlet>)
│   │   ├── app.config.ts             # App configuration (provideIonicAngular, provideRouter)
│   │   ├── app.routes.ts             # Root route definitions
│   │   ├── home/
│   │   │   ├── home.page.ts          # Page component (standalone)
│   │   │   ├── home.page.html        # Page template
│   │   │   ├── home.page.scss        # Page styles
│   │   │   └── home.page.spec.ts     # Page unit tests
│   │   ├── services/
│   │   │   └── data.service.ts       # Injectable services
│   │   ├── guards/
│   │   │   └── auth.guard.ts         # Route guards
│   │   └── shared/
│   │       └── components/           # Shared standalone components
│   ├── assets/                       # Static assets (images, fonts, icons)
│   ├── environments/
│   │   ├── environment.ts            # Development environment config
│   │   └── environment.prod.ts       # Production environment config
│   ├── global.scss                   # Global styles and Ionic theme variables
│   ├── index.html                    # Main HTML entry point
│   ├── main.ts                       # App bootstrap (bootstrapApplication)
│   └── theme/
│       └── variables.scss            # Ionic CSS custom properties (colors, fonts)
├── angular.json                      # Angular CLI workspace config
├── capacitor.config.ts               # Capacitor configuration (or .json)
├── ionic.config.json                 # Ionic CLI configuration
├── package.json
└── tsconfig.json
```

### NgModule Architecture

```
my-app/
├── src/
│   ├── app/
│   │   ├── app.component.ts
│   │   ├── app.component.html
│   │   ├── app.module.ts             # Root NgModule (imports IonicModule.forRoot())
│   │   ├── app-routing.module.ts     # Root routing module
│   │   ├── home/
│   │   │   ├── home.page.ts          # Page component (declared in module)
│   │   │   ├── home.page.html
│   │   │   ├── home.page.scss
│   │   │   ├── home.page.spec.ts
│   │   │   ├── home.module.ts        # Page module (imports IonicModule)
│   │   │   └── home-routing.module.ts # Page routing module
│   │   └── ...
│   └── ...
└── ...
```

Key difference: NgModule projects have `app.module.ts`, `app-routing.module.ts`, and per-page `*.module.ts` + `*-routing.module.ts` files.

## Key Files

### `ionic.config.json`

Ionic CLI configuration. Contains the app name, integration type, and project type:

```json
{
  "name": "my-app",
  "integrations": {
    "capacitor": {}
  },
  "type": "angular"
}
```

### `src/global.scss`

Imports Ionic core styles and optional utility classes. This file is referenced in `angular.json` under `styles`:

```scss
/* Core Ionic styles */
@import '@ionic/angular/css/core.css';

/* Basic CSS for Ionic apps */
@import '@ionic/angular/css/normalize.css';
@import '@ionic/angular/css/structure.css';
@import '@ionic/angular/css/typography.css';
@import '@ionic/angular/css/display.css';

/* Optional CSS utilities from Ionic */
@import '@ionic/angular/css/padding.css';
@import '@ionic/angular/css/float-elements.css';
@import '@ionic/angular/css/text-alignment.css';
@import '@ionic/angular/css/text-transformation.css';
@import '@ionic/angular/css/flex-utils.css';
```

### `src/theme/variables.scss`

Defines Ionic CSS custom properties for colors, fonts, and platform overrides:

```scss
:root {
  --ion-color-primary: #3880ff;
  --ion-color-secondary: #3dc2ff;
  --ion-color-tertiary: #5260ff;
  --ion-color-success: #2dd36f;
  --ion-color-warning: #ffc409;
  --ion-color-danger: #eb445a;
  --ion-color-dark: #222428;
  --ion-color-medium: #92949c;
  --ion-color-light: #f4f5f8;
}
```

### `src/index.html`

Must contain `<app-root>` for Angular bootstrap. Ionic adds meta tags for viewport and status bar:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>My App</title>
    <meta name="viewport" content="viewport-fit=cover, width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <meta name="color-scheme" content="light dark" />
    <meta name="format-detection" content="telephone=no" />
    <link rel="icon" type="image/png" href="assets/icon/favicon.png" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
```

The `viewport-fit=cover` value is required for proper safe-area handling on iOS (notch, home indicator).

## Generating Pages and Components

Use the Ionic CLI to generate pages and components that follow the project's architecture:

```bash
# Generate a new page
ionic generate page my-page

# Generate a new component
ionic generate component my-component

# Generate a new service
ionic generate service services/my-service

# Generate a new guard
ionic generate guard guards/auth
```

The Ionic CLI detects whether the project uses standalone or NgModule and generates the appropriate files.
