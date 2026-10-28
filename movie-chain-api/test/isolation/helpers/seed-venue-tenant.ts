import { addStaff, asAdmin, createTenant, type SeededTenant } from '../../support/seed';

export interface VenueTenant extends SeededTenant {
  adminEmail: string;
  adminId: string;
  theatreId: string;
  otherTheatreId: string;
  screenId: string;
  otherScreenId: string;
  seatId: string;
  clerkId: string;
}

/** A tenant with an admin, two theatres (one screen + seats each) and a clerk. */
export async function seedVenueTenant(adminUrl: string, label: string): Promise<VenueTenant> {
  return asAdmin(adminUrl, async (c) => {
    const t = await createTenant(c);
    const adminEmail = `admin@${label}.test`;
    const adminId = await addStaff(c, t.id, adminEmail, 'chain_admin');
    const clerkId = await addStaff(c, t.id, `clerk@${label}.test`, 'box_office');
    const ids: string[][] = [];
    for (const name of ['Westlands', 'Garden City']) {
      const th = (await c.query(`INSERT INTO theatre (tenant_id, name, city) VALUES ($1, $2, 'Nairobi') RETURNING id`, [t.id, name])).rows[0].id;
      const sc = (await c.query(`INSERT INTO screen (tenant_id, theatre_id, name) VALUES ($1, $2, 'Screen 1') RETURNING id`, [t.id, th])).rows[0].id;
      const st = (
        await c.query(
          `INSERT INTO seat (tenant_id, screen_id, row_label, seat_number, row_index, col_index)
           SELECT $1, $2, 'A', n, 0, n - 1 FROM generate_series(1, 4) n RETURNING id`,
          [t.id, sc],
        )
      ).rows[0].id;
      ids.push([th, sc, st]);
    }
    return {
      ...t,
      adminEmail,
      adminId,
      clerkId,
      theatreId: ids[0]![0]!,
      screenId: ids[0]![1]!,
      seatId: ids[0]![2]!,
      otherTheatreId: ids[1]![0]!,
      otherScreenId: ids[1]![1]!,
    };
  });
}
