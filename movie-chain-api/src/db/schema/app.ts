/**
 * The schema visible to application-plane code through db(). platform.* is
 * deliberately absent: it lives on the identity connection (step 6).
 */
export * from './tenant';
export * from './staff-user';
export * from './tenant-customer';
export * from './audit';
export * from './venue';
export * from './catalogue';
export * from './screening';
export * from './inventory';
