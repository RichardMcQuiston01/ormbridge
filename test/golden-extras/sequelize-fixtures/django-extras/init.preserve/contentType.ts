import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class ContentType extends Model<
  InferAttributes<ContentType>,
  InferCreationAttributes<ContentType>
> {
  declare id: CreationOptional<number>;

  static initModel(sequelize: Sequelize): typeof ContentType {
    ContentType.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      },
      {
        sequelize,
        modelName: 'ContentType',
        tableName: 'blog_contenttype',
        timestamps: false,
      }
    );
    return ContentType;
  }
}
