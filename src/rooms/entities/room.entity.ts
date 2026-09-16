import { Room as RoomModel, RoomType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export class Room implements RoomModel {
    id: string;
    hotelId: string;
    roomNumber: string;
    type: RoomType;
    pricePerNight: Decimal;
    capacity: number;
    createdAt: Date;
}