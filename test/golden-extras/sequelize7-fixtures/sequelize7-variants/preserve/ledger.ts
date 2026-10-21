import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  Default,
  NotNull,
  PrimaryKey,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'ledger', timestamps: false, underscored: true })
export class Ledger extends Model<
  InferAttributes<Ledger>,
  InferCreationAttributes<Ledger>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.BIGINT)
  declare hits: CreationOptional<string | null>;

  @Attribute(DataTypes.DECIMAL(12, 2))
  @NotNull
  @Default(0)
  declare balance: CreationOptional<string>;

  @Attribute(DataTypes.DOUBLE)
  declare ratio: CreationOptional<number | null>;

  @Attribute(DataTypes.DATEONLY)
  declare openedOn: CreationOptional<string | null>;

  @Attribute(DataTypes.BLOB)
  declare receipt: CreationOptional<Buffer | null>;

  @Attribute(DataTypes.JSONB)
  declare settings: CreationOptional<unknown | null>;
}
