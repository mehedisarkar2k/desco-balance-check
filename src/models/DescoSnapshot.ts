import mongoose, { Schema, Document } from "mongoose";

/**
 * The last good copy of something fetched from DESCO, kept so a request can
 * be answered when DESCO is slow or down, and so history outlives the ~45 days
 * DESCO itself will serve.
 */
export interface IDescoSnapshot extends Document {
    /** "<kind>:<accountNo>:<meterNo>". */
    key: string;
    payload: any;
    /** Earliest date a series has been fetched from, for range lookups. */
    coveredFrom?: string;
    fetchedAt: Date;
}

const DescoSnapshotSchema = new Schema<IDescoSnapshot>({
    key: { type: String, required: true, unique: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    coveredFrom: String,
    fetchedAt: { type: Date, required: true },
});

export const DescoSnapshot = mongoose.model<IDescoSnapshot>("DescoSnapshot", DescoSnapshotSchema);
