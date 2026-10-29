import { InjectionToken, inject } from '@angular/core';
import type { ContactAddressesEngine } from './contact-addresses-engine';
import { JsSdkContactAddressesEngine } from './js-sdk/js-sdk-contact-addresses-engine';

export const CONTACT_ADDRESSES_ENGINE =
  new InjectionToken<ContactAddressesEngine>('CONTACT_ADDRESSES_ENGINE', {
    providedIn: 'root',
    factory: () => inject(JsSdkContactAddressesEngine),
  });
