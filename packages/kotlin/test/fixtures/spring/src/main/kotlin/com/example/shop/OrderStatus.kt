package com.example.shop

import jakarta.persistence.AttributeConverter
import jakarta.persistence.Converter

enum class OrderStatus(val code: String) {
    NEW("new"),
    PAID("paid"),
}

@Converter
class StatusConverter : AttributeConverter<OrderStatus, String> {
    override fun convertToDatabaseColumn(attribute: OrderStatus?): String? = attribute?.code

    override fun convertToEntityAttribute(dbData: String?): OrderStatus? =
        OrderStatus.values().firstOrNull { it.code == dbData }
}
