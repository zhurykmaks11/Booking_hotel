import { Guest as GuestModel } from '@prisma/client';

export class Guest implements GuestModel {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    createdAt: Date;
}