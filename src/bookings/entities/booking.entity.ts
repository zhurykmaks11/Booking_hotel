import { Booking as BookingModel, BookingStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

export class Booking implements BookingModel {
    id: string;
    roomId: string;
    guestId: string;
    checkInDate: Date;
    checkOutDate: Date;
    status: BookingStatus;
    totalPrice: Decimal;
    createdAt: Date;
}