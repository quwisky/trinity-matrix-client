---
title: Forms and validation
description: Build Trinity forms with Angular Signal Forms, accessible fields, and separate domain validation.
audience: developer
contentChannel: develop
canonicalTopic: development-forms-validation
pageType: how-to
platforms: [web, desktop, android, ios]
---

New Trinity forms use Angular Signal Forms. Existing login, registration, and prompt flows provide current examples based on `form()`, `FormField`, and validation rules.

## Model the editable value {#form-model}

Create a private signal for the editable model and derive a form tree from it. Put required, length, and cross-field presentation rules in the form schema. Bind public Trinity controls through `[formField]` so value, disabled state, touched state, and errors stay coordinated.

```ts
private readonly model = signal({ name: '' });
readonly roomForm = form(this.model, (path) => {
  required(path.name, { message: 'Enter a room name.' });
});
```

Signal Forms owns a bound field's disabled state. Do not add a competing `[disabled]` binding to the same control.

## Separate UI and domain validation {#validation-boundary}

The form validates what the user can correct locally. The data-access service validates permissions, Matrix identifiers, server outcomes, and concurrency at the capability boundary. Never treat client validation as authorization.

Show errors next to the labeled field, associate descriptions correctly, and move focus or announce a summary when submission fails in a way the current field does not explain.

## Submit a finite action {#submit-action}

Read the valid form value once, invoke the owning service, and retain the subscription for the component lifetime. Prevent duplicate submission through form state and the command's busy state. Preserve typed service outcomes instead of reducing every failure to a generic boolean.

Test visible validation, disabled behavior, keyboard submission, server rejection, and the successful command boundary. Read [Angular components](../angular-components/) for interaction ownership and [data-access services](../data-access-services/) for domain checks.
