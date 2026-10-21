package extras.embeddedkeys;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import lombok.AllArgsConstructor;
import lombok.EqualsAndHashCode;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

// The key class of Stock: a plain column (sku) and the column that the @MapsId relationship fills (warehouseId).
@Embeddable
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@EqualsAndHashCode
public class StockId implements Serializable {
  private static final long serialVersionUID = 1L;

  @Column(name = "sku", length = 20)
  private String sku;

  @Column(name = "warehouse_id")
  private Long warehouseId;
}
