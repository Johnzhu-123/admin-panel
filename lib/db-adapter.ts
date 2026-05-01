/**
 * Database Adapter Layer
 * 
 * Provides compatibility between @vercel/postgres and @neondatabase/serverless
 * - Wraps @neondatabase/serverless to match @vercel/postgres API
 * - Returns { rows, rowCount } format like @vercel/postgres
 */

import { neon, NeonQueryFunction } from '@neondatabase/serverless';

// Cache the database function
let neonSql: NeonQueryFunction<boolean, boolean> | null = null;

function getNeonSql() {
    if (!neonSql) {
        const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

        if (!connectionString) {
            throw new Error('Database connection string not found. Set POSTGRES_URL or DATABASE_URL environment variable.');
        }

        neonSql = neon(connectionString);
    }

    return neonSql;
}

/**
 * Result type compatible with @vercel/postgres
 */
interface CompatibleQueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number;
}

/**
 * SQL tagged template function compatible with @vercel/postgres
 * 
 * @example
 * const result = await sql`SELECT * FROM users WHERE id = ${userId}`;
 * // result.rows contains the rows
 * // result.rowCount contains the count
 */
export async function sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
): Promise<CompatibleQueryResult<T>> {
    const neonFn = getNeonSql();

    // Neon returns array of rows directly
    const rows = await neonFn(strings, ...values) as T[];

    return {
        rows: Array.isArray(rows) ? rows : [],
        rowCount: Array.isArray(rows) ? rows.length : 0
    };
}

// Re-export for convenience
export { neon };
