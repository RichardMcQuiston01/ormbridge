package extras.embeddedkeys;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.MapsId;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Getter
@Setter
@NoArgsConstructor
public class Stock {
  @EmbeddedId private StockId id;

  @MapsId("warehouseId")
  @ManyToOne(optional = false)
  @JoinColumn(name = "warehouse_id")
  private Warehouse warehouse;

  @Column(nullable = false)
  private int quantity;
}
