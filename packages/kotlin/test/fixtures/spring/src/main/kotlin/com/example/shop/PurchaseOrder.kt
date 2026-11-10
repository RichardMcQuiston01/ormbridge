package com.example.shop

import jakarta.persistence.*
import java.math.BigDecimal

@Entity
@Table(
    name = "purchase_order",
    indexes = [Index(name = "idx_order_status", columnList = "status")],
    uniqueConstraints = [UniqueConstraint(columnNames = ["customer_id", "number"])],
)
class PurchaseOrder : BaseEntity() {
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id")
    lateinit var customer: Customer

    @Column(nullable = false)
    var number: Int = 0

    @Column(precision = 12, scale = 2)
    var total: BigDecimal = BigDecimal.ZERO

    @Convert(converter = StatusConverter::class)
    var status: OrderStatus = OrderStatus.NEW

    @Lob
    var notes: ByteArray? = null

    @ManyToMany
    @JoinTable(name = "order_tag")
    var tags: MutableSet<Tag> = mutableSetOf()
}

@Entity
class Tag(@Id var code: String = "")
