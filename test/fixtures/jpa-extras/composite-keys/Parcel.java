package extras.keys;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;

@Entity
public class Parcel {
  @Id private Long id;

  // A second, read-only mapping of the foreign key column: the relationship carries the column.
  @Column(name = "shipment_id", insertable = false, updatable = false)
  private Long shipmentId;

  @ManyToOne
  @JoinColumn(name = "shipment_id")
  private Shipment shipment;
}
