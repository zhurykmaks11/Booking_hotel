import { Hotel as HotelModel } from '@prisma/client';

export class Hotel implements HotelModel {
    id: string;
    name: string;
    address: string;
    city: string;
    rating: number;
    createdAt: Date;
}