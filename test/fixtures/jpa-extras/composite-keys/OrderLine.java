package extras.keys;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;

@Entity
@IdClass(OrderLineId.class)
public class OrderLine {
  @Id private Long orderId;

  @Id private Integer lineNo;

  private String sku;
}
